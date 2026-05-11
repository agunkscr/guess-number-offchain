require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs").promises;
const path = require("path");
const { ethers } = require("ethers");

// ========== ENV ==========
const RPC_URL = process.env.RPC_URL_AUTHEO;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const PRIVATE_KEY_PLAYER1 = process.env.PRIVATE_KEY_PLAYER1;
const PRIVATE_KEY_PLAYER2 = process.env.PRIVATE_KEY_PLAYER2;
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

// ========== STATE ==========
let rooms = {};
let processedTxs = new Set();
let roomCounter = 0;
let isProcessingBlock = false;

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

// ========== LOGIKA GAME ==========
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
      const tx = await wallet.sendTransaction({ to: winner.wallet, value: totalPot });
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
    // refund all
    try {
      for (const p of paidPlayers) {
        const tx = await wallet.sendTransaction({ to: p.wallet, value: room.betAmountWei });
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
      const tx = await wallet.sendTransaction({ to: p.wallet, value: room.betAmountWei });
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

async function processIncomingTransaction(tx) {
  if (processedTxs.has(tx.hash)) return;
  processedTxs.add(tx.hash);
  if (!tx.to) return;
  if (tx.to.toLowerCase() !== treasuryAddress.toLowerCase()) return;

  let roomId;
  try {
    if (!tx.data || tx.data === "0x") return;
    const data = ethers.utils.arrayify(tx.data);
    if (data.length < 32) return;
    roomId = ethers.BigNumber.from(data.slice(0, 32)).toNumber();
  } catch { return; }

  const room = rooms[roomId];
  if (!room || room.status !== "waiting") return;
  if (tx.value < room.betAmountWei) return;

  const player = room.players.find(
    p => p.wallet.toLowerCase() === tx.from.toLowerCase() && p.status === "registered"
  );
  if (!player) return;
  player.status = "paid";
  player.txHash = tx.hash;
  console.log(`Player ${player.wallet} paid`);

  await saveData();
  checkRoomCompletion(roomId);
}

async function onNewBlock(blockNumber) {
  if (isProcessingBlock) return;
  isProcessingBlock = true;
  try {
    const block = await provider.getBlockWithTransactions(blockNumber);
    for (const tx of block.transactions) {
      await processIncomingTransaction(tx);
    }
  } catch (err) {
    console.error("Block processing error:", err.message);
  } finally {
    isProcessingBlock = false;
  }
}

async function checkAllRooms() {
  for (const roomId of Object.keys(rooms)) {
    checkRoomCompletion(parseInt(roomId));
  }
}

// ========== AUTO GAME (sekali main) ==========
async function autoPlayRoom(betAmount, secretNumber) {
  if (!player1 || !player2)
    throw new Error("Player wallets not configured. Set PRIVATE_KEY_PLAYER1 and PRIVATE_KEY_PLAYER2 in .env");

  roomCounter++;
  const roomId = roomCounter;
  const actualNumber = secretNumber || Math.floor(Math.random() * 10) + 1;
  const deadline = Date.now() + 600000;

  rooms[roomId] = {
    id: roomId,
    secretNumber: actualNumber,
    maxPlayers: 2,
    betAmountWei: ethers.utils.parseEther(betAmount),
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

  const sendBet = async (w, addr) => {
    const tx = await w.sendTransaction({
      to: treasuryAddress,
      value: rooms[roomId].betAmountWei,
      data: ethers.utils.hexZeroPad(ethers.utils.hexlify(roomId), 32),
    });
    console.log(`${addr} sent bet, tx: ${tx.hash}`);
    await tx.wait();
    console.log(`${addr} bet confirmed`);
  };

  await Promise.all([sendBet(player1, player1.address), sendBet(player2, player2.address)]);
  console.log(`Both bets confirmed for room ${roomId}`);
  await checkRoomCompletion(roomId);
  return rooms[roomId];
}

// ========== AUTO LOOP (berulang) ==========
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
  }, 30000); // setiap 30 detik, sesuaikan dengan kecepatan transaksi
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

// Register player (before paying)
app.post("/api/rooms/:id/register", async (req, res) => {
  const roomId = parseInt(req.params.id);
  const { wallet: playerWallet, guess } = req.body;
  if (!ethers.utils.isAddress(playerWallet)) return res.status(400).json({ error: "Invalid wallet address" });
  if (!guess || guess < 1 || guess > 10) return res.status(400).json({ error: "Guess must be 1-10" });
  const room = rooms[roomId];
  if (!room || room.status !== "waiting") return res.status(404).json({ error: "Room not available" });
  if (room.players.length >= room.maxPlayers) return res.status(400).json({ error: "Room full" });
  if (room.players.find(p => p.wallet.toLowerCase() === playerWallet.toLowerCase()))
    return res.status(400).json({ error: "Wallet already registered" });
  room.players.push({ wallet: playerWallet, guess, status: "registered" });
  await saveData();
  res.json({ success: true, message: "Please send bet to treasury with proper data" });
});

// Room detail
app.get("/api/rooms/:id", (req, res) => {
  const room = rooms[parseInt(req.params.id)];
  if (!room) return res.status(404).json({ error: "Room not found" });
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

// List all rooms
app.get("/api/rooms", (req, res) => {
  const list = Object.values(rooms).map(r => ({
    id: r.id,
    maxPlayers: r.maxPlayers,
    betAmount: r.betAmount,
    status: r.status,
    playerCount: r.players.length,
  }));
  res.json(list);
});

// Leaderboard
app.get("/api/leaderboard", (req, res) => {
  const wins = {};
  for (const room of Object.values(rooms)) {
    if (room.status === "revealed" && room.winner) {
      wins[room.winner] = (wins[room.winner] || 0) + 1;
    }
  }
  const sorted = Object.entries(wins)
    .map(([wallet, count]) => ({ wallet, wins: count }))
    .sort((a, b) => b.wins - a.wins);
  res.json(sorted);
});

// Transaction history
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
    res.json({
      message: "Auto game completed",
      roomId: room.id,
      status: room.status,
      secretNumber: room.secretNumber,
      winner: room.winner || "none (refund)",
      players: room.players.map(p => ({ wallet: p.wallet, guess: p.guess, status: p.status })),
      payoutTx: room.payoutTx,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Auto-loop start/stop/status
app.post("/api/auto-loop/start", requireAdmin, (req, res) => {
  const { betAmount = "0.01" } = req.body;
  if (autoLoopActive) return res.status(400).json({ error: "Loop already running" });
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

// ========== START SERVER ==========
async function main() {
  await initDataDir();
  await loadData();
  console.log(`Treasury: ${treasuryAddress}`);
  if (player1) console.log(`Player1: ${player1.address}`);
  if (player2) console.log(`Player2: ${player2.address}`);
  await checkAllRooms();
  provider.on("block", onNewBlock);
  setInterval(checkAllRooms, 30000);
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(player1 && player2 ? "✅ Auto-game & Auto-loop ready" : "⚠️  Player wallets not set. Auto modes disabled.");
  });
}

main().catch(console.error);
