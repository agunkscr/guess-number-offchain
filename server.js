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
const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const treasuryAddress = wallet.address;

let player1, player2;
if (PRIVATE_KEY_PLAYER1) player1 = new ethers.Wallet(PRIVATE_KEY_PLAYER1, provider);
if (PRIVATE_KEY_PLAYER2) player2 = new ethers.Wallet(PRIVATE_KEY_PLAYER2, provider);

// ========== CX1 TOKEN ==========
const erc20Abi = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)"
];
const cx1 = new ethers.Contract(CX1_TOKEN_ADDRESS, erc20Abi, provider);

// ========== STATE ==========
let rooms = {};
let processedTxs = new Set();
let roomCounter = 0;

// Auto-loop
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
  } catch {
    rooms = {};
    roomCounter = 0;
    processedTxs = new Set();
  }
}

async function saveData() {
  await fs.writeFile(DATA_FILE, JSON.stringify({
    rooms,
    roomCounter,
    processedTxs: Array.from(processedTxs),
  }, null, 2));
}

// ========== LOGIKA GAME (ERC‑20) ==========
function checkRoomCompletion(roomId) {
  const room = rooms[roomId];
  if (!room || room.status !== "waiting") return;
  const now = Date.now();
  const allPaid = room.players.every(p => p.status === "paid");
  const isFull = room.players.length >= room.maxPlayers;
  const deadlinePassed = now >= room.deadline;

  if (allPaid && isFull) {
    resolveRoom(roomId);
  } else if (deadlinePassed) {
    refundRoom(roomId);
  }
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
  console.log(`Refunding room ${roomId} due to deadline...`);
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

// Deteksi Transfer CX1 dari pemain ke treasury
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
      console.log(`Insufficient CX1 from ${from} for room ${roomId}`);
      continue;
    }
    player.status = "paid";
    player.txHash = txHash;
    console.log(`Player ${from} paid ${ethers.utils.formatEther(value)} CX1 for room ${roomId}`);
    await saveData();
    checkRoomCompletion(parseInt(roomId));
    break;
  }
}

// ========== AUTO GAME ==========
async function autoPlayRoom(betAmount, secretNumber) {
  if (!player1 || !player2) throw new Error("Player wallets not set.");
  if (!CX1_TOKEN_ADDRESS) throw new Error("CX1_TOKEN_ADDRESS not set");

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

  console.log(`Room ${roomId} created (secret: ${actualNumber})`);

  const sendCX1 = async (playerWallet, addr) => {
    const tx = await cx1.connect(playerWallet).transfer(treasuryAddress, betWei);
    console.log(`${addr} sent CX1, tx: ${tx.hash}`);
    await tx.wait();
    console.log(`${addr} CX1 transfer confirmed`);
  };

  await Promise.all([sendCX1(player1, player1.address), sendCX1(player2, player2.address)]);
  console.log(`Both CX1 payments confirmed for room ${roomId}`);
  await new Promise(r => setTimeout(r, 2000));
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
  if (autoLoopInterval) {
    clearInterval(autoLoopInterval);
    autoLoopInterval = null;
  }
  console.log("Auto-loop stopped.");
}

// ========== EXPRESS ==========
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function requireAdmin(req, res, next) {
  if (req.headers["x-api-key"] !== ADMIN_API_KEY) return res.status(403).json({ error: "Forbidden" });
  next();
}

// Health-check root
app.get("/", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// Create room manual (admin)
app.post("/api/rooms", requireAdmin, async (req, res) => {
  const { maxPlayers, betAmount } = req.body;
  if (!maxPlayers || maxPlayers < 2) return res.status(400).json({ error: "maxPlayers minimal 2" });
  if (!betAmount || isNaN(betAmount)) return res.status(400).json({ error: "betAmount harus numerik" });
  roomCounter++;
  const roomId = roomCounter;
  const secretNumber = Math.floor(Math.random() * 10) + 1;
  const deadline = Date.now() + 600000;
  rooms[roomId] = {
    id: roomId,
    secretNumber,
    maxPlayers,
    betAmountWei: ethers.utils.parseEther(betAmount),
    betAmount,
    deadline,
    status: "waiting",
    players: [],
    createdAt: Date.now(),
  };
  await saveData();
  res.json({ roomId, treasuryAddress, betAmount, maxPlayers, deadline });
});

// Register player
app.post("/api/rooms/:id/register", async (req, res) => {
  const roomId = parseInt(req.params.id);
  const { wallet: playerWallet, guess } = req.body;
  if (!ethers.utils.isAddress(playerWallet)) return res.status(400).json({ error: "Invalid wallet" });
  if (!guess || guess < 1 || guess > 10) return res.status(400).json({ error: "Guess 1-10" });
  const room = rooms[roomId];
  if (!room || room.status !== "waiting") return res.status(404).json({ error: "Room not available" });
  if (room.players.length >= room.maxPlayers) return res.status(400).json({ error: "Room full" });
  if (room.players.find(p => p.wallet.toLowerCase() === playerWallet.toLowerCase()))
    return res.status(400).json({ error: "Already registered" });
  room.players.push({ wallet: playerWallet, guess, status: "registered" });
  await saveData();
  res.json({ success: true, message: `Kirim ${room.betAmount} CX1 ke ${treasuryAddress}` });
});

// Room detail
app.get("/api/rooms/:id", (req, res) => {
  const room = rooms[parseInt(req.params.id)];
  if (!room) return res.status(404).json({ error: "Not found" });
  const safeRoom = {
    id: room.id,
    maxPlayers: room.maxPlayers,
    betAmount: room.betAmount,
    deadline: room.deadline,
    status: room.status,
    players: room.players.map(p => ({
      wallet: p.wallet,
      status: p.status,
      guess: room.status !== "waiting" ? p.guess : undefined,
    })),
    secretNumber: room.status !== "waiting" ? room.secretNumber : undefined,
    winner: room.winner,
    payoutTx: room.payoutTx,
  };
  res.json(safeRoom);
});

// List rooms
app.get("/api/rooms", (req, res) => {
  res.json(Object.values(rooms).map(r => ({
    id: r.id, maxPlayers: r.maxPlayers, betAmount: r.betAmount,
    status: r.status, playerCount: r.players.length,
  })));
});

// Leaderboard
app.get("/api/leaderboard", (req, res) => {
  const wins = {};
  for (const room of Object.values(rooms)) {
    if (room.status === "revealed" && room.winner) {
      wins[room.winner] = (wins[room.winner] || 0) + 1;
    }
  }
  const sorted = Object.entries(wins).map(([wallet, count]) => ({ wallet, wins: count })).sort((a, b) => b.wins - a.wins);
  res.json(sorted);
});

// Transactions
app.get("/api/transactions", (req, res) => {
  const txs = [];
  for (const room of Object.values(rooms)) {
    for (const p of room.players) {
      if (p.txHash) txs.push({ type: "deposit", roomId: room.id, from: p.wallet, txHash: p.txHash, amount: room.betAmount });
      if (p.refundTx) txs.push({ type: "refund", roomId: room.id, to: p.wallet, txHash: p.refundTx, amount: room.betAmount });
    }
    if (room.payoutTx) {
      const total = room.players.filter(p => p.status === "paid").reduce((s) => s + parseFloat(room.betAmount), 0);
      txs.push({ type: "payout", roomId: room.id, to: room.winner, txHash: room.payoutTx, amount: total.toString() });
    }
  }
  res.json(txs);
});

// Auto game sekali
app.post("/api/auto-game", requireAdmin, async (req, res) => {
  const { betAmount = "0.01", secretNumber } = req.body;
  if (isNaN(parseFloat(betAmount)) || parseFloat(betAmount) <= 0) return res.status(400).json({ error: "Invalid betAmount" });
  try {
    const room = await autoPlayRoom(betAmount, secretNumber || undefined);
    res.json({ message: "Auto game completed", roomId: room.id, status: room.status, secretNumber: room.secretNumber, winner: room.winner || "none", players: room.players.map(p => ({ wallet: p.wallet, guess: p.guess, status: p.status })), payoutTx: room.payoutTx });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Auto-loop
app.post("/api/auto-loop/start", requireAdmin, (req, res) => {
  const { betAmount = "0.01" } = req.body;
  if (autoLoopActive) return res.status(400).json({ error: "Already running" });
  startAutoLoop(betAmount);
  res.json({ message: "Auto-loop started", betAmount });
});

app.post("/api/auto-loop/stop", requireAdmin, (req, res) => {
  stopAutoLoop();
  res.json({ message: "Auto-loop stopped" });
});

app.get("/api/auto-loop/status", (req, res) => {
  res.json({ active: autoLoopActive, count: autoLoopCount, betAmount: autoLoopBetAmount });
});

// Konfigurasi untuk frontend
app.get("/api/config", (req, res) => {
  res.json({
    treasuryAddress,
    cx1TokenAddress: CX1_TOKEN_ADDRESS,
  });
});

// ========== LISTENER CX1 ==========
async function setupEventListener() {
  try {
    const filter = cx1.filters.Transfer(null, treasuryAddress);
    cx1.on(filter, async (from, to, value, event) => {
      try {
        await handleCX1Transfer(from, to, value, event);
      } catch (err) {
        console.error("Error handling Transfer event:", err.message);
      }
    });
    console.log("Listening for CX1 transfers...");
  } catch (err) {
    console.error("Failed to setup CX1 event listener:", err.message);
  }
}

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
  console.log(`Treasury: ${treasuryAddress}`);
  if (player1) console.log(`Player1: ${player1.address}`);
  if (player2) console.log(`Player2: ${player2.address}`);
  if (!CX1_TOKEN_ADDRESS) {
    console.error("⚠️  CX1_TOKEN_ADDRESS not set! Set it in .env");
    process.exit(1);
  }

  await checkAllRooms();
  await setupEventListener();

  const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(player1 && player2 ? "✅ Auto-game & Auto-loop ready" : "⚠️  Player wallets not set. Auto modes disabled.");
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down...');
    server.close(() => {
      console.log('HTTP server closed');
      cx1.removeAllListeners();
      process.exit(0);
    });
  });
}

main().catch(console.error);