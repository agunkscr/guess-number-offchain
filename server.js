require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs").promises;
const path = require("path");
const { ethers } = require("ethers");

// ========== GLOBAL ERROR HANDLERS ==========
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

// ========== ENV ==========
const RPC_URL = process.env.RPC_URL_AUTHEO;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const PRIVATE_KEY_PLAYER1 = process.env.PRIVATE_KEY_PLAYER1;
const PRIVATE_KEY_PLAYER2 = process.env.PRIVATE_KEY_PLAYER2;
const CX1_TOKEN_ADDRESS = process.env.CX1_TOKEN_ADDRESS;
const PORT = process.env.PORT || 3000;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "supersecret";

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "roomsData.json");

// ========== PROVIDER & WALLETS ==========
let provider, wallet, treasuryAddress;
let player1, player2;
let cx1;

try {
  provider = new ethers.providers.JsonRpcProvider(RPC_URL);
  wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  treasuryAddress = wallet.address;
  console.log(`Treasury: ${treasuryAddress}`);

  if (PRIVATE_KEY_PLAYER1) {
    player1 = new ethers.Wallet(PRIVATE_KEY_PLAYER1, provider);
    console.log(`Player1: ${player1.address}`);
  }
  if (PRIVATE_KEY_PLAYER2) {
    player2 = new ethers.Wallet(PRIVATE_KEY_PLAYER2, provider);
    console.log(`Player2: ${player2.address}`);
  }

  const erc20Abi = [
    "function transfer(address to, uint256 amount) returns (bool)",
    "function balanceOf(address owner) view returns (uint256)",
    "event Transfer(address indexed from, address indexed to, uint256 value)"
  ];
  cx1 = new ethers.Contract(CX1_TOKEN_ADDRESS, erc20Abi, provider);
} catch (err) {
  console.error("Failed to initialize wallets/contract:", err.message);
  process.exit(1);
}

// ========== STATE ==========
let rooms = {};
let processedTxs = new Set();
let roomCounter = 0;
let lastCheckedBlock = 0;

let autoLoopActive = false;
let autoLoopInterval = null;
let autoLoopBetAmount = "0.01";
let autoLoopCount = 0;

// ========== PERSISTENT STORAGE ==========
async function initDataDir() {
  try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch (_) {}
}

async function loadData() {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf-8");
    const data = JSON.parse(raw);
    rooms = data.rooms || {};
    roomCounter = data.roomCounter || 0;
    processedTxs = new Set(data.processedTxs || []);
    lastCheckedBlock = data.lastCheckedBlock || 0;
  } catch {
    rooms = {};
    roomCounter = 0;
    processedTxs = new Set();
    lastCheckedBlock = 0;
  }
}

async function saveData() {
  await fs.writeFile(DATA_FILE, JSON.stringify({
    rooms,
    roomCounter,
    processedTxs: Array.from(processedTxs),
    lastCheckedBlock,
  }, null, 2));
}

// ========== LOGIKA GAME ==========
function checkRoomCompletion(roomId) {
  const room = rooms[roomId];
  if (!room || room.status !== "waiting") return;
  const now = Date.now();
  const allPaid = room.players.every(p => p.status === "paid");
  const isFull = room.players.length >= room.maxPlayers;
  const deadlinePassed = now >= room.deadline;

  if (allPaid && isFull) resolveRoom(roomId);
  else if (deadlinePassed) refundRoom(roomId);
}

async function resolveRoom(roomId) {
  const room = rooms[roomId];
  if (room.status !== "waiting") return;
  room.status = "processing";
  console.log(`Resolving room ${roomId}...`);

  const paidPlayers = room.players.filter(p => p.status === "paid");
  const winners = paidPlayers.filter(p => p.guess === room.secretNumber);

  if (winners.length > 0) {
    const winner = winners[0];
    const totalPot = paidPlayers.reduce((sum, p) => sum + room.betAmountWei, 0n);
    try {
      const tx = await cx1.connect(wallet).transfer(winner.wallet, totalPot);
      await tx.wait();
      room.winner = winner.wallet;
      room.payoutTx = tx.hash;
      console.log(`Winner ${winner.wallet} paid ${ethers.utils.formatEther(totalPot)} CX1`);
    } catch (err) {
      console.error(`Payout failed:`, err.message);
      room.status = "waiting";
      return;
    }
  } else {
    try {
      for (const p of paidPlayers) {
        const tx = await cx1.connect(wallet).transfer(p.wallet, room.betAmountWei);
        await tx.wait();
        p.refundTx = tx.hash;
      }
      room.status = "refunded";
    } catch (err) {
      console.error(`Refund failed:`, err.message);
      room.status = "waiting";
      return;
    }
  }

  room.status = "revealed";
  room.resolvedAt = Date.now();
  await saveData();
}

async function refundRoom(roomId) {
  const room = rooms[roomId];
  if (room.status !== "waiting") return;
  room.status = "refunding";
  console.log(`Refunding room ${roomId}...`);
  const paidPlayers = room.players.filter(p => p.status === "paid");
  for (const p of paidPlayers) {
    try {
      const tx = await cx1.connect(wallet).transfer(p.wallet, room.betAmountWei);
      await tx.wait();
      p.refundTx = tx.hash;
    } catch (err) {
      console.error(`Refund failed for ${p.wallet}:`, err.message);
    }
  }
  room.status = "refunded";
  room.resolvedAt = Date.now();
  await saveData();
}

async function handleCX1Transfer(from, to, value, event) {
  const txHash = event.transactionHash;
  if (processedTxs.has(txHash)) return;
  processedTxs.add(txHash);

  if (!to || to.toLowerCase() !== treasuryAddress.toLowerCase()) return;

  for (const roomId of Object.keys(rooms)) {
    const room = rooms[roomId];
    if (room.status !== "waiting") continue;
    const player = room.players.find(
      p => p.wallet.toLowerCase() === from.toLowerCase() && p.status === "registered"
    );
    if (!player) continue;
    if (value.lt(room.betAmountWei)) {
      console.log(`Insufficient CX1 from ${from}`);
      continue;
    }
    player.status = "paid";
    player.txHash = txHash;
    console.log(`Player ${from} paid ${ethers.utils.formatEther(value)} CX1`);
    await saveData();
    checkRoomCompletion(parseInt(roomId));
    break;
  }
}

// ========== POLLING LOG CX1 ==========
async function pollCX1Transfers() {
  try {
    const currentBlock = await provider.getBlockNumber();
    if (lastCheckedBlock === 0) {
      lastCheckedBlock = currentBlock;
      await saveData();
      return;
    }
    if (currentBlock <= lastCheckedBlock) return;

    const filter = cx1.filters.Transfer(null, treasuryAddress);
    const logs = await provider.getLogs({
      ...filter,
      fromBlock: lastCheckedBlock + 1,
      toBlock: currentBlock,
    });

    for (const log of logs) {
      const parsed = cx1.interface.parseLog(log);
      await handleCX1Transfer(parsed.args.from, parsed.args.to, parsed.args.value, log);
    }

    lastCheckedBlock = currentBlock;
    await saveData();
  } catch (err) {
    console.error("Polling CX1 error:", err.message);
  }
}

// ========== AUTO GAME ==========
async function autoPlayRoom(betAmount, secretNumber) {
  if (!player1 || !player2) throw new Error("Player wallets not set.");
  roomCounter++;
  const roomId = roomCounter;
  const actualNumber = secretNumber || Math.floor(Math.random() * 10) + 1;
  const deadline = Date.now() + 600000;
  const betWei = ethers.utils.parseEther(betAmount);

  rooms[roomId] = {
    id: roomId,
    secretNumber: actualNumber,
    maxPlayers: 2,
    betAmountWei: betWei,
    betAmount,
    deadline,
    status: "waiting",
    players: [],
    createdAt: Date.now(),
  };

  const room = rooms[roomId];
  const guess1 = Math.floor(Math.random() * 10) + 1;
  let guess2 = Math.floor(Math.random() * 10) + 1;
  while (guess2 === guess1) guess2 = Math.floor(Math.random() * 10) + 1;

  room.players.push({ wallet: player1.address, guess: guess1, status: "registered" });
  room.players.push({ wallet: player2.address, guess: guess2, status: "registered" });
  await saveData();

  const sendCX1 = async (playerWallet, addr) => {
    const tx = await cx1.connect(playerWallet).transfer(treasuryAddress, betWei);
    await tx.wait();
    console.log(`${addr} CX1 transfer confirmed`);
  };

  await Promise.all([sendCX1(player1, player1.address), sendCX1(player2, player2.address)]);
  await new Promise(r => setTimeout(r, 5000));
  await pollCX1Transfers();
  await checkRoomCompletion(roomId);
  return rooms[roomId];
}

// ========== AUTO LOOP ==========
async function startAutoLoop(betAmount) {
  if (autoLoopActive) return;
  autoLoopActive = true;
  autoLoopBetAmount = betAmount;
  autoLoopCount = 0;
  console.log(`Auto-loop started with bet ${betAmount} CX1`);

  autoLoopInterval = setInterval(async () => {
    if (!autoLoopActive) {
      clearInterval(autoLoopInterval);
      autoLoopInterval = null;
      return;
    }
    try {
      autoLoopCount++;
      console.log(`Auto-loop: starting game #${autoLoopCount}`);
      await autoPlayRoom(autoLoopBetAmount, undefined);
      console.log(`Auto-loop: game #${autoLoopCount} completed`);
    } catch (err) {
      console.error(`Auto-loop error at game #${autoLoopCount}:`, err.message);
    }
  }, 30000);
}

function stopAutoLoop() {
  autoLoopActive = false;
  if (autoLoopInterval) clearInterval(autoLoopInterval);
  autoLoopInterval = null;
  console.log("Auto-loop stopped.");
}

// ========== EXPRESS ==========
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Middleware logging untuk debug healthcheck
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

function requireAdmin(req, res, next) {
  if (req.headers["x-api-key"] !== ADMIN_API_KEY) return res.status(403).json({ error: "Forbidden" });
  next();
}

// Health-check root
app.get("/", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// === endpoint lain sama seperti sebelumnya ===
app.post("/api/rooms", requireAdmin, async (req, res) => { ... });
// ... (semua endpoint yang sudah ada) ...
app.get("/api/config", (req, res) => { ... });

// ========== CHECK ALL ROOMS ==========
async function checkAllRooms() {
  for (const roomId of Object.keys(rooms)) {
    checkRoomCompletion(parseInt(roomId));
  }
}

// ========== START SERVER ==========
async function main() {
  await initDataDir();
  await loadData();

  // Pastikan provider siap
  try {
    await provider.getBlockNumber();
    console.log("RPC connected, current block:", await provider.getBlockNumber());
  } catch (e) {
    console.error("RPC connection failed:", e.message);
    process.exit(1);
  }

  await checkAllRooms();

  // Polling setiap 10 detik
  setInterval(pollCX1Transfers, 10000);
  // Jalankan sekali di awal dengan delay agar tidak ganggu server startup
  setTimeout(() => pollCX1Transfers().catch(console.error), 1000);

  const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });

  process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down...');
    server.close(() => {
      console.log('HTTP server closed');
      process.exit(0);
    });
  });
}

main().catch(console.error);