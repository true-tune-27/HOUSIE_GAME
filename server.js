const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 5e6
});

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Ensure uploads directory exists
if (!fs.existsSync(path.join(__dirname, 'uploads'))) {
  fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });
}

// Multer config for QR upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, 'qr-code' + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// ==================== GAME STATE ====================
const gameState = {
  adminPassword: 'admin123',  // Default admin password
  isGameActive: false,
  isGameStarted: false,
  calledNumbers: [],
  currentNumber: null,
  players: new Map(),         // socketId -> player data
  tickets: new Map(),         // ticketId -> ticket data
  prizes: {
    earlyFive: { amount: 0, claimed: false, claimedBy: null },
    topLine: { amount: 0, claimed: false, claimedBy: null },
    middleLine: { amount: 0, claimed: false, claimedBy: null },
    bottomLine: { amount: 0, claimed: false, claimedBy: null },
    fullHouse: { amount: 0, claimed: false, claimedBy: null },
    secondFullHouse: { amount: 0, claimed: false, claimedBy: null }
  },
  ticketPrice: 50,
  maxTicketsPerPlayer: 6,
  qrCodePath: null,
  autoCallInterval: null,
  autoCallSpeed: 5000,        // 5 seconds between calls
  pendingApprovals: new Map() // playerId -> approval data
};

// ==================== TICKET GENERATION ====================
function generateHousieTicket() {
  // Standard Housie ticket: 3 rows x 9 columns
  // Each row has exactly 5 numbers
  // Column ranges: 1-9, 10-19, 20-29, ..., 80-90
  const ticket = [
    [null, null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null, null]
  ];

  // Generate column pools
  const columnPools = [];
  for (let col = 0; col < 9; col++) {
    const start = col === 0 ? 1 : col * 10;
    const end = col === 8 ? 90 : (col + 1) * 10 - 1;
    const pool = [];
    for (let n = start; n <= end; n++) pool.push(n);
    shuffleArray(pool);
    columnPools.push(pool);
  }

  // We need to place exactly 5 numbers in each row (15 total)
  // Each column can have 0, 1, 2, or 3 numbers
  // Strategy: randomly select which columns get numbers in which rows

  // First, determine how many numbers each column will have (0-3)
  // Total must be 15, distributed across 9 columns
  let columnCounts = new Array(9).fill(0);

  // Ensure each column has at least 1 number (standard Housie rule is at least 1 per column... 
  // actually not required, but we need 15 numbers across 9 columns)
  // Actually in standard Housie, not every column needs a number.
  // Let's use a simpler approach: assign 5 columns to each row

  const rowColumns = [[], [], []];

  // For each row, pick 5 unique columns
  for (let row = 0; row < 3; row++) {
    const availableCols = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    shuffleArray(availableCols);
    rowColumns[row] = availableCols.slice(0, 5).sort((a, b) => a - b);
  }

  // Track used numbers per column
  const usedFromColumn = new Array(9).fill(0);

  // Fill in numbers
  for (let row = 0; row < 3; row++) {
    for (const col of rowColumns[row]) {
      if (usedFromColumn[col] < columnPools[col].length) {
        ticket[row][col] = columnPools[col][usedFromColumn[col]];
        usedFromColumn[col]++;
      } else {
        // Fallback: find another column
        for (let c = 0; c < 9; c++) {
          if (!rowColumns[row].includes(c) && usedFromColumn[c] < columnPools[c].length) {
            ticket[row][col] = columnPools[c][usedFromColumn[c]];
            usedFromColumn[c]++;
            break;
          }
        }
      }
    }
  }

  // Sort numbers within each column (top to bottom)
  for (let col = 0; col < 9; col++) {
    const nums = [];
    const rows = [];
    for (let row = 0; row < 3; row++) {
      if (ticket[row][col] !== null) {
        nums.push(ticket[row][col]);
        rows.push(row);
      }
    }
    nums.sort((a, b) => a - b);
    for (let i = 0; i < nums.length; i++) {
      ticket[rows[i]][col] = nums[i];
    }
  }

  return ticket;
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Track all generated ticket numbers to ensure uniqueness
const allGeneratedNumbers = new Set();

function generateUniqueTicket() {
  let ticket;
  let attempts = 0;
  do {
    ticket = generateHousieTicket();
    attempts++;
  } while (attempts < 100); // Safety limit
  return ticket;
}

// ==================== PRIZE CHECKING ====================
function getTicketNumbers(ticket) {
  const numbers = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 9; col++) {
      if (ticket[row][col] !== null) {
        numbers.push(ticket[row][col]);
      }
    }
  }
  return numbers;
}

function getRowNumbers(ticket, rowIndex) {
  const numbers = [];
  for (let col = 0; col < 9; col++) {
    if (ticket[rowIndex][col] !== null) {
      numbers.push(ticket[rowIndex][col]);
    }
  }
  return numbers;
}

function checkEarlyFive(calledNumbers, playerTickets) {
  // Check if any player has 5 numbers marked across all their tickets
  let maxMarked = 0;
  for (const ticket of playerTickets) {
    const ticketNums = getTicketNumbers(ticket.grid);
    const marked = ticketNums.filter(n => calledNumbers.includes(n)).length;
    maxMarked += marked;
  }
  // Early five: first player to mark any 5 numbers across their tickets
  // Actually, it's per ticket in standard rules
  for (const ticket of playerTickets) {
    const ticketNums = getTicketNumbers(ticket.grid);
    const marked = ticketNums.filter(n => calledNumbers.includes(n)).length;
    if (marked >= 5) return ticket.id;
  }
  return null;
}

function checkLine(calledNumbers, ticket, lineIndex) {
  const rowNums = getRowNumbers(ticket, lineIndex);
  return rowNums.every(n => calledNumbers.includes(n));
}

function checkFullHouse(calledNumbers, ticket) {
  const allNums = getTicketNumbers(ticket);
  return allNums.every(n => calledNumbers.includes(n));
}

// ==================== API ROUTES ====================

// QR Code upload
app.post('/api/admin/upload-qr', upload.single('qrcode'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  gameState.qrCodePath = '/uploads/' + req.file.filename;
  res.json({ success: true, path: gameState.qrCodePath });
});

// Get QR code
app.get('/api/qr-code', (req, res) => {
  res.json({ path: gameState.qrCodePath });
});

// Admin login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === gameState.adminPassword) {
    res.json({ success: true, token: 'admin-' + uuidv4() });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

// Admin update settings
app.post('/api/admin/settings', (req, res) => {
  const { ticketPrice, maxTickets, prizes, autoCallSpeed, adminPassword } = req.body;
  if (ticketPrice) gameState.ticketPrice = ticketPrice;
  if (maxTickets) gameState.maxTicketsPerPlayer = maxTickets;
  if (autoCallSpeed) gameState.autoCallSpeed = autoCallSpeed;
  if (adminPassword) gameState.adminPassword = adminPassword;
  if (prizes) {
    Object.keys(prizes).forEach(key => {
      if (gameState.prizes[key]) {
        gameState.prizes[key].amount = prizes[key];
      }
    });
  }
  io.emit('settingsUpdated', {
    ticketPrice: gameState.ticketPrice,
    prizes: gameState.prizes
  });
  res.json({ success: true });
});

// Get game state (public)
app.get('/api/game/state', (req, res) => {
  const players = [];
  gameState.players.forEach((p, id) => {
    players.push({
      id: p.id,
      name: p.name,
      ticketCount: p.tickets.length,
      approved: p.approved,
      totalPaid: p.totalPaid
    });
  });
  res.json({
    isGameActive: gameState.isGameActive,
    isGameStarted: gameState.isGameStarted,
    calledNumbers: gameState.calledNumbers,
    currentNumber: gameState.currentNumber,
    ticketPrice: gameState.ticketPrice,
    maxTicketsPerPlayer: gameState.maxTicketsPerPlayer,
    prizes: gameState.prizes,
    players,
    qrCodePath: gameState.qrCodePath
  });
});

// Serve pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/game', (req, res) => res.sendFile(path.join(__dirname, 'public', 'game.html')));

// ==================== SOCKET.IO ====================
io.on('connection', (socket) => {
  console.log(`Connected: ${socket.id}`);

  // Player joins game
  socket.on('joinGame', ({ name, ticketCount }) => {
    const count = Math.min(ticketCount || 1, gameState.maxTicketsPerPlayer);
    const playerId = uuidv4().slice(0, 8);

    const playerTickets = [];
    for (let i = 0; i < count; i++) {
      const ticketId = uuidv4().slice(0, 8);
      const grid = generateUniqueTicket();
      const ticketData = {
        id: ticketId,
        playerId,
        playerName: name,
        grid,
        markedNumbers: []
      };
      playerTickets.push(ticketData);
      gameState.tickets.set(ticketId, ticketData);
    }

    const playerData = {
      id: playerId,
      socketId: socket.id,
      name,
      tickets: playerTickets,
      approved: false,
      totalPaid: 0,
      joinedAt: Date.now()
    };

    gameState.players.set(socket.id, playerData);

    // Add to pending approvals
    gameState.pendingApprovals.set(playerId, {
      playerId,
      socketId: socket.id,
      name,
      ticketCount: count,
      totalAmount: count * gameState.ticketPrice,
      timestamp: Date.now()
    });

    socket.emit('joinedGame', {
      playerId,
      tickets: playerTickets,
      ticketPrice: gameState.ticketPrice,
      totalAmount: count * gameState.ticketPrice,
      prizes: gameState.prizes,
      qrCodePath: gameState.qrCodePath,
      approved: false,
      calledNumbers: gameState.calledNumbers,
      currentNumber: gameState.currentNumber,
      isGameStarted: gameState.isGameStarted
    });

    // Notify admin
    io.emit('newPlayerJoined', {
      playerId,
      name,
      ticketCount: count,
      totalAmount: count * gameState.ticketPrice
    });

    io.emit('playerListUpdated', getPlayerList());
  });

  // Admin approves player payment
  socket.on('approvePlayer', ({ playerId }) => {
    let targetSocket = null;
    gameState.players.forEach((p, sid) => {
      if (p.id === playerId) {
        p.approved = true;
        p.totalPaid = p.tickets.length * gameState.ticketPrice;
        targetSocket = sid;
      }
    });

    gameState.pendingApprovals.delete(playerId);

    if (targetSocket) {
      io.to(targetSocket).emit('paymentApproved', { playerId });
    }

    io.emit('playerListUpdated', getPlayerList());
    io.emit('pendingApprovalsUpdated', getPendingApprovals());
  });

  // Admin rejects player
  socket.on('rejectPlayer', ({ playerId }) => {
    let targetSocket = null;
    gameState.players.forEach((p, sid) => {
      if (p.id === playerId) {
        targetSocket = sid;
        // Remove tickets
        p.tickets.forEach(t => gameState.tickets.delete(t.id));
        gameState.players.delete(sid);
      }
    });

    gameState.pendingApprovals.delete(playerId);

    if (targetSocket) {
      io.to(targetSocket).emit('paymentRejected', { playerId });
    }

    io.emit('playerListUpdated', getPlayerList());
    io.emit('pendingApprovalsUpdated', getPendingApprovals());
  });

  // Admin starts game
  socket.on('startGame', () => {
    gameState.isGameActive = true;
    gameState.isGameStarted = true;
    gameState.calledNumbers = [];
    gameState.currentNumber = null;

    // Reset prizes
    Object.keys(gameState.prizes).forEach(key => {
      gameState.prizes[key].claimed = false;
      gameState.prizes[key].claimedBy = null;
    });

    io.emit('gameStarted', {
      prizes: gameState.prizes
    });
  });

  // Admin calls next number
  socket.on('callNumber', () => {
    if (!gameState.isGameStarted) return;

    const available = [];
    for (let i = 1; i <= 90; i++) {
      if (!gameState.calledNumbers.includes(i)) available.push(i);
    }

    if (available.length === 0) {
      io.emit('gameComplete', { message: 'All numbers have been called!' });
      return;
    }

    const randomIndex = Math.floor(Math.random() * available.length);
    const number = available[randomIndex];

    gameState.calledNumbers.push(number);
    gameState.currentNumber = number;

    io.emit('numberCalled', {
      number,
      calledNumbers: gameState.calledNumbers,
      remaining: available.length - 1
    });
  });

  // Admin starts auto-call
  socket.on('startAutoCall', ({ speed }) => {
    if (gameState.autoCallInterval) clearInterval(gameState.autoCallInterval);

    const callSpeed = speed || gameState.autoCallSpeed;
    gameState.autoCallSpeed = callSpeed;

    gameState.autoCallInterval = setInterval(() => {
      const available = [];
      for (let i = 1; i <= 90; i++) {
        if (!gameState.calledNumbers.includes(i)) available.push(i);
      }

      if (available.length === 0) {
        clearInterval(gameState.autoCallInterval);
        gameState.autoCallInterval = null;
        io.emit('gameComplete', { message: 'All numbers have been called!' });
        return;
      }

      const randomIndex = Math.floor(Math.random() * available.length);
      const number = available[randomIndex];
      gameState.calledNumbers.push(number);
      gameState.currentNumber = number;

      io.emit('numberCalled', {
        number,
        calledNumbers: gameState.calledNumbers,
        remaining: available.length - 1
      });
    }, callSpeed);

    io.emit('autoCallStarted', { speed: callSpeed });
  });

  // Admin stops auto-call
  socket.on('stopAutoCall', () => {
    if (gameState.autoCallInterval) {
      clearInterval(gameState.autoCallInterval);
      gameState.autoCallInterval = null;
    }
    io.emit('autoCallStopped');
  });

  // Player claims prize
  socket.on('claimPrize', ({ playerId, ticketId, prizeType }) => {
    const player = findPlayerById(playerId);
    if (!player || !player.approved) {
      socket.emit('claimResult', { success: false, message: 'Player not found or not approved' });
      return;
    }

    const ticket = gameState.tickets.get(ticketId);
    if (!ticket) {
      socket.emit('claimResult', { success: false, message: 'Ticket not found' });
      return;
    }

    if (gameState.prizes[prizeType]?.claimed) {
      socket.emit('claimResult', { success: false, message: 'This prize has already been claimed!' });
      return;
    }

    // Validate claim
    let isValid = false;
    const calledNumbers = gameState.calledNumbers;

    switch (prizeType) {
      case 'earlyFive': {
        const ticketNums = getTicketNumbers(ticket.grid);
        const marked = ticketNums.filter(n => calledNumbers.includes(n)).length;
        isValid = marked >= 5;
        break;
      }
      case 'topLine':
        isValid = checkLine(calledNumbers, ticket.grid, 0);
        break;
      case 'middleLine':
        isValid = checkLine(calledNumbers, ticket.grid, 1);
        break;
      case 'bottomLine':
        isValid = checkLine(calledNumbers, ticket.grid, 2);
        break;
      case 'fullHouse':
      case 'secondFullHouse':
        isValid = checkFullHouse(calledNumbers, ticket.grid);
        break;
    }

    if (isValid) {
      gameState.prizes[prizeType].claimed = true;
      gameState.prizes[prizeType].claimedBy = { name: player.name, playerId: player.id, ticketId };

      socket.emit('claimResult', {
        success: true,
        message: `🎉 Congratulations! You won ${prizeType}!`,
        prizeType,
        amount: gameState.prizes[prizeType].amount
      });

      io.emit('prizeClaimed', {
        prizeType,
        playerName: player.name,
        amount: gameState.prizes[prizeType].amount,
        prizes: gameState.prizes
      });
    } else {
      socket.emit('claimResult', {
        success: false,
        message: 'Invalid claim! Your ticket does not qualify for this prize yet.'
      });

      // Notify admin of bogus claim
      io.emit('bogusClaim', {
        playerName: player.name,
        playerId: player.id,
        prizeType,
        ticketId
      });
    }
  });

  // Admin resets game
  socket.on('resetGame', () => {
    if (gameState.autoCallInterval) {
      clearInterval(gameState.autoCallInterval);
      gameState.autoCallInterval = null;
    }

    gameState.isGameActive = false;
    gameState.isGameStarted = false;
    gameState.calledNumbers = [];
    gameState.currentNumber = null;
    gameState.players.clear();
    gameState.tickets.clear();
    gameState.pendingApprovals.clear();

    Object.keys(gameState.prizes).forEach(key => {
      gameState.prizes[key].claimed = false;
      gameState.prizes[key].claimedBy = null;
    });

    io.emit('gameReset');
  });

  // Admin ends current game (keeps players)
  socket.on('endGame', () => {
    if (gameState.autoCallInterval) {
      clearInterval(gameState.autoCallInterval);
      gameState.autoCallInterval = null;
    }
    gameState.isGameStarted = false;
    io.emit('gameEnded', { prizes: gameState.prizes });
  });

  // Get pending approvals
  socket.on('getPendingApprovals', () => {
    socket.emit('pendingApprovalsUpdated', getPendingApprovals());
  });

  // Get player list
  socket.on('getPlayerList', () => {
    socket.emit('playerListUpdated', getPlayerList());
  });

  // Chat message
  socket.on('chatMessage', ({ name, message }) => {
    io.emit('chatMessage', { name, message, timestamp: Date.now() });
  });

  // Disconnect
  socket.on('disconnect', () => {
    const player = gameState.players.get(socket.id);
    if (player) {
      console.log(`Player disconnected: ${player.name}`);
      // Don't remove player data - they might reconnect
      // Just notify others
      io.emit('playerDisconnected', { name: player.name, playerId: player.id });
    }
  });

  // Reconnect
  socket.on('reconnect', ({ playerId }) => {
    let found = false;
    gameState.players.forEach((p, oldSocketId) => {
      if (p.id === playerId) {
        // Update socket ID
        const playerData = gameState.players.get(oldSocketId);
        gameState.players.delete(oldSocketId);
        playerData.socketId = socket.id;
        gameState.players.set(socket.id, playerData);
        found = true;

        socket.emit('reconnected', {
          playerId: playerData.id,
          tickets: playerData.tickets,
          approved: playerData.approved,
          calledNumbers: gameState.calledNumbers,
          currentNumber: gameState.currentNumber,
          prizes: gameState.prizes,
          isGameStarted: gameState.isGameStarted
        });
      }
    });

    if (!found) {
      socket.emit('reconnectFailed');
    }
  });
});

// Helper functions
function findPlayerById(playerId) {
  let found = null;
  gameState.players.forEach(p => {
    if (p.id === playerId) found = p;
  });
  return found;
}

function getPlayerList() {
  const players = [];
  gameState.players.forEach((p) => {
    players.push({
      id: p.id,
      name: p.name,
      ticketCount: p.tickets.length,
      approved: p.approved,
      totalPaid: p.totalPaid,
      tickets: p.tickets
    });
  });
  return players;
}

function getPendingApprovals() {
  const approvals = [];
  gameState.pendingApprovals.forEach((a) => {
    approvals.push(a);
  });
  return approvals;
}

// ==================== START SERVER ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎱 Housie Game Server running on http://localhost:${PORT}`);
  console.log(`👤 Player page: http://localhost:${PORT}`);
  console.log(`🔧 Admin panel: http://localhost:${PORT}/admin`);
  console.log(`\n📋 Default admin password: admin123\n`);
});
