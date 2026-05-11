require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs").promises;
const path = require("path");
const { ethers } = require("ethers");

// ========== GLOBAL ERROR HANDLERS ==========
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
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
    "event Transfer(address indexed from, address indexed to, uint256 value)",
  ];
  cx1 = new ethers.Contract(CX1_TOKEN_ADDRESS, erc20Abi, provider);
} catch (err) {
  console.error("Failed to initialize wallets/contract:", err.message);
  process.exit(1);
}

// ========== HELPERS: BigNumber serialization ==========
// ethers.BigNumber tidak survive JSON round-trip.
// Simpan sebagai string hex, load kembali pakai BigNumber.from().

function serializeRoom(room) {
  return {
    ...room,
    betAmountWei: room.betAmountWei.toHexString(),
  };
}

function deserializeRoom(room) {
  return {
    ...room,
    betAmountWei: ethers.BigNumber.from(room.betAmountWei),
  };
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
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (_) {}
}

async function loadData() {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf-8");
    const data = JSON.parse(raw);

    // Deserialize BigNumber dari string hex
    const rawRooms = data.rooms || {};
    rooms = {};
    for (const [id, room] of Object.entries(rawRooms)) {
      rooms[id] = deserializeRoom(room);
    }

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
  // Serialize BigNumber ke string hex sebelum disimpan
  const serializedRooms = {};
  for (const [id, room] of Object.entries(rooms)) {
    serializedRooms[id] = serializeRoom(room);
  }

  await fs.writeFile(
    DATA_FILE,
    JSON.stringify(
      {
        rooms: serializedRooms,
        roomCounter,
        processedTxs: Array.from(processedTxs),
        lastCheckedBlock,
      },
      null,
      2
    )
  );
}

// ========== LOGIKA GAME ==========
// FIX: dibuat async agar resolveRoom/refundRoom bisa di-await dengan benar
async function checkRoomCompletion(roomId) {
  const room = rooms[roomId];
  if (!room || room.status !== "waiting") return;
  const now = Date.now();
  const allPaid = room.players.every((p) => p.status === "paid");
  const isFull = room.players.length >= room.maxPlayers;
  const deadlinePassed = now >= room.deadline;

  if (allPaid && isFull) await resolveRoom(roomId);
  else if (deadlinePassed) await refundRoom(roomId);
}

async function resolveRoom(roomId) {
  const room = rooms[roomId];
  if (room.status !== "waiting") return;
  room.status = "processing";
  console.log(`Resolving room ${roomId}...`);

  const paidPlayers = room.players.filter((p) => p.status === "paid");
  const winners = paidPlayers.filter((p) => p.guess === room.secretNumber);

  if (winners.length > 0) {
    const winner = winners[0];

    // FIX: gunakan BigNumber.add() bukan native BigInt 0n
    const totalPot = paidPlayers.reduce(
      (sum, _p) => sum.add(room.betAmountWei),
      ethers.BigNumber.from(0)
    );

    try {
      const tx = await cx1.connect(wallet).transfer(winner.wallet, totalPot);
      await tx.wait();
      room.winner = winner.wallet;
      room.payoutTx = tx.hash;
      room.status = "revealed";
      room.resolvedAt = Date.now();
      console.log(
        `Winner ${winner.wallet} paid ${ethers.utils.formatEther(totalPot)} CX1`
      );
    } catch (err) {
      console.error(`Payout failed:`, err.message);
      room.status = "waiting"; // rollback agar bisa retry
      return;
    }
  } else {
    // Tidak ada pemenang → refund semua
    let refundFailed = false;
    for (const p of paidPlayers) {
      try {
        const tx = await cx1.connect(wallet).transfer(p.wallet, room.betAmountWei);
        await tx.wait();
        p.refundTx = tx.hash;
      } catch (err) {
        console.error(`Refund failed for ${p.wallet}:`, err.message);
        refundFailed = true;
      }
    }
    // FIX: jangan override status dengan "revealed" jika ini path refund
    room.status = refundFailed ? "refund_partial" : "refunded";
    room.resolvedAt = Date.now();
  }

  await saveData();
}

async function refundRoom(roomId) {
  const room = rooms[roomId];
  if (room.status !== "waiting") return;
  room.status = "refunding";
  console.log(`Refunding room ${roomId} (deadline passed)...`);

  const paidPlayers = room.players.filter((p) => p.status === "paid");
  let refundFailed = false;

  for (const p of paidPlayers) {
    try {
      const tx = await cx1.connect(wallet).transfer(p.wallet, room.betAmountWei);
      await tx.wait();
      p.refundTx = tx.hash;
    } catch (err) {
      console.error(`Refund failed for ${p.wallet}:`, err.message);
      refundFailed = true;
    }
  }

  room.status = refundFailed ? "refund_partial" : "refunded";
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
      (p) =>
        p.wallet.toLowerCase() === from.toLowerCase() &&
        p.status === "registered"
    );
    if (!player) continue;

    // FIX: room.betAmountWei sekarang dijamin BigNumber (via deserializeRoom)
    if (value.lt(room.betAmountWei)) {
      console.log(`Insufficient CX1 from ${from}`);
      continue;
    }

    player.status = "paid";
    player.txHash = txHash;
    console.log(
      `Player ${from} paid ${ethers.utils.formatEther(value)} CX1 for room ${roomId}`
    );
    await saveData();
    await checkRoomCompletion(parseInt(roomId));
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
      await handleCX1Transfer(
        parsed.args.from,
        parsed.args.to,
        parsed.args.value,
        log
      );
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

  const sendCX1 = async (playerWallet, label) => {
    const tx = await cx1.connect(playerWallet).transfer(treasuryAddress, betWei);
    await tx.wait();
    console.log(`${label} CX1 transfer confirmed`);
  };

  await Promise.all([
    sendCX1(player1, player1.address),
    sendCX1(player2, player2.address),
  ]);

  // Tunggu beberapa detik biar block ter-mine
  await new Promise((r) => setTimeout(r, 5000));
  await pollCX1Transfers();

  // FIX: checkRoomCompletion sekarang async, di-await agar room benar-benar selesai
  // sebelum return ke caller
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

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

function requireAdmin(req, res, next) {
  if (req.headers["x-api-key"] !== ADMIN_API_KEY)
    return res.status(403).json({ error: "Forbidden" });
  next();
}

// ========== ENDPOINTS ==========

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// Config publik untuk frontend
app.get("/api/config", (req, res) => {
  res.json({
    treasuryAddress,
    cx1TokenAddress: CX1_TOKEN_ADDRESS,
  });
});

// List semua rooms (tanpa secretNumber)
app.get("/api/rooms", (req, res) => {
  const list = Object.values(rooms).map((r) => ({
    id: r.id,
    status: r.status,
    maxPlayers: r.maxPlayers,
    playerCount: r.players.length,
    betAmount: r.betAmount,
    deadline: r.deadline,
    createdAt: r.createdAt,
    winner: r.winner || null,
  }));
  // Urutkan terbaru di atas
  list.sort((a, b) => b.id - a.id);
  res.json(list);
});

// Detail satu room
app.get("/api/rooms/:id", (req, res) => {
  const room = rooms[parseInt(req.params.id)];
  if (!room) return res.status(404).json({ error: "Room not found" });

  const isResolved = ["revealed", "refunded", "refund_partial"].includes(room.status);

  res.json({
    id: room.id,
    status: room.status,
    maxPlayers: room.maxPlayers,
    betAmount: room.betAmount,
    deadline: room.deadline,
    createdAt: room.createdAt,
    resolvedAt: room.resolvedAt || null,
    winner: room.winner || null,
    payoutTx: room.payoutTx || null,
    // Angka rahasia hanya ditampilkan setelah selesai
    secretNumber: isResolved ? room.secretNumber : undefined,
    players: room.players.map((p) => ({
      wallet: p.wallet,
      guess: isResolved ? p.guess : undefined,
      status: p.status,
      txHash: p.txHash || null,
      refundTx: p.refundTx || null,
    })),
  });
});

// Buat room baru (manual, admin only)
app.post("/api/rooms", requireAdmin, async (req, res) => {
  try {
    const maxPlayers = parseInt(req.body.maxPlayers) || 2;
    const betAmount = req.body.betAmount || "0.01";

    if (maxPlayers < 2 || maxPlayers > 10)
      return res.status(400).json({ error: "maxPlayers harus antara 2-10" });

    const betWei = ethers.utils.parseEther(betAmount);
    const secretNumber = Math.floor(Math.random() * 10) + 1;

    roomCounter++;
    const roomId = roomCounter;

    rooms[roomId] = {
      id: roomId,
      secretNumber,
      maxPlayers,
      betAmountWei: betWei,
      betAmount,
      deadline: Date.now() + 600000, // 10 menit
      status: "waiting",
      players: [],
      createdAt: Date.now(),
    };

    await saveData();
    console.log(`Room ${roomId} created, secret: ${secretNumber}`);
    res.json({ roomId, treasuryAddress, betAmount, deadline: rooms[roomId].deadline });
  } catch (err) {
    console.error("Create room error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Daftar ke room
app.post("/api/rooms/:id/register", async (req, res) => {
  try {
    const roomId = parseInt(req.params.id);
    const { wallet: playerWallet, guess } = req.body;

    if (!playerWallet || !ethers.utils.isAddress(playerWallet))
      return res.status(400).json({ error: "Wallet address tidak valid" });

    const guessNum = parseInt(guess);
    if (!guessNum || guessNum < 1 || guessNum > 10)
      return res.status(400).json({ error: "Tebakan harus angka 1-10" });

    const room = rooms[roomId];
    if (!room) return res.status(404).json({ error: "Room tidak ditemukan" });
    if (room.status !== "waiting")
      return res.status(400).json({ error: "Room sudah tidak aktif" });
    if (room.players.length >= room.maxPlayers)
      return res.status(400).json({ error: "Room sudah penuh" });
    if (Date.now() >= room.deadline)
      return res.status(400).json({ error: "Deadline sudah lewat" });

    const alreadyIn = room.players.find(
      (p) => p.wallet.toLowerCase() === playerWallet.toLowerCase()
    );
    if (alreadyIn)
      return res.status(400).json({ error: "Wallet sudah terdaftar di room ini" });

    room.players.push({
      wallet: playerWallet,
      guess: guessNum,
      status: "registered",
    });

    await saveData();
    res.json({
      success: true,
      treasuryAddress,
      betAmount: room.betAmount,
      message: `Berhasil daftar. Kirim ${room.betAmount} CX1 ke ${treasuryAddress} untuk konfirmasi.`,
    });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Auto game sekali (admin only)
app.post("/api/auto-game", requireAdmin, async (req, res) => {
  try {
    const betAmount = req.body.betAmount || "0.01";
    const result = await autoPlayRoom(betAmount, undefined);
    res.json({
      roomId: result.id,
      status: result.status,
      winner: result.winner || null,
      secretNumber: result.secretNumber,
      players: result.players.map((p) => ({
        wallet: p.wallet,
        guess: p.guess,
        status: p.status,
      })),
    });
  } catch (err) {
    console.error("Auto game error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Start auto loop (admin only)
app.post("/api/auto-loop/start", requireAdmin, async (req, res) => {
  try {
    if (autoLoopActive)
      return res.status(400).json({ error: "Loop sudah berjalan" });
    const betAmount = req.body.betAmount || "0.01";
    await startAutoLoop(betAmount);
    res.json({ success: true, message: "Auto-loop dimulai", betAmount });
  } catch (err) {
    console.error("Auto-loop start error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Stop auto loop (admin only)
app.post("/api/auto-loop/stop", requireAdmin, (req, res) => {
  stopAutoLoop();
  res.json({ success: true, message: "Auto-loop dihentikan" });
});

// Status auto loop
app.get("/api/auto-loop/status", (req, res) => {
  res.json({
    active: autoLoopActive,
    count: autoLoopCount,
    betAmount: autoLoopBetAmount,
  });
});

// Leaderboard
app.get("/api/leaderboard", (req, res) => {
  const wins = {};
  for (const room of Object.values(rooms)) {
    if (room.winner) {
      const addr = room.winner.toLowerCase();
      wins[addr] = (wins[addr] || 0) + 1;
    }
  }
  const leaderboard = Object.entries(wins)
    .map(([wallet, count]) => ({ wallet, wins: count }))
    .sort((a, b) => b.wins - a.wins)
    .slice(0, 20);
  res.json(leaderboard);
});

// ========== CHECK ALL ROOMS ==========
async function checkAllRooms() {
  for (const roomId of Object.keys(rooms)) {
    await checkRoomCompletion(parseInt(roomId));
  }
}

// ========== START SERVER ==========
async function main() {
  await initDataDir();
  await loadData();

  try {
    const block = await provider.getBlockNumber();
    console.log("RPC connected, current block:", block);
  } catch (e) {
    console.error("RPC connection failed:", e.message);
    process.exit(1);
  }

  await checkAllRooms();

  setInterval(pollCX1Transfers, 10000);
  setTimeout(() => pollCX1Transfers().catch(console.error), 1000);

  const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });

  process.on("SIGTERM", () => {
    console.log("SIGTERM received, shutting down...");
    server.close(() => {
      console.log("HTTP server closed");
      process.exit(0);
    });
  });
}

main().catch(console.error);
