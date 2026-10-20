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
  maxHttpBufferSize: 5e6,
  pingTimeout: 60000,
  pingInterval: 25000
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
  filename: (req, file, cb) => {
    const roomKey = req.params.roomKey || 'default';
    cb(null, `qr-${roomKey}${path.extname(file.originalname)}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// ==================== ROOM MANAGEMENT ====================
// rooms: Map<roomKey, roomState>
const rooms = new Map();

// Generate a short human-readable room key (6 chars uppercase)
function generateRoomKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Exclude confusing chars
  let key = '';
  for (let i = 0; i < 6; i++) {
    key += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  // Ensure unique
  if (rooms.has(key)) return generateRoomKey();
  return key;
}

function createRoomState(roomKey, adminPassword) {
  return {
    roomKey,
    adminPassword: adminPassword || 'admin123',
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
    autoCallSpeed: 5000,
    pendingApprovals: new Map(), // playerId -> approval data
    createdAt: Date.now(),
    adminSockets: new Set()      // track admin socket IDs
  };
}

function getRoom(roomKey) {
  return rooms.get(roomKey);
}

// Clean up stale rooms (older than 24 hours with no players)
function cleanupRooms() {
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours
  rooms.forEach((room, key) => {
    if (room.players.size === 0 && room.adminSockets.size === 0 && (now - room.createdAt) > maxAge) {
      if (room.autoCallInterval) clearInterval(room.autoCallInterval);
      rooms.delete(key);
      console.log(`🗑️ Cleaned up stale room: ${key}`);
    }
  });
}
// Run cleanup every hour
setInterval(cleanupRooms, 60 * 60 * 1000);

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

// Create a new room (admin)
app.post('/api/room/create', (req, res) => {
  const { adminPassword } = req.body;
  const roomKey = generateRoomKey();
  const roomState = createRoomState(roomKey, adminPassword || 'admin123');
  rooms.set(roomKey, roomState);
  console.log(`🏠 Room created: ${roomKey}`);
  res.json({ success: true, roomKey });
});

// Validate room key
app.get('/api/room/validate/:roomKey', (req, res) => {
  const roomKey = req.params.roomKey.toUpperCase();
  const room = getRoom(roomKey);
  if (room) {
    res.json({
      valid: true,
      roomKey,
      isGameStarted: room.isGameStarted,
      ticketPrice: room.ticketPrice,
      maxTicketsPerPlayer: room.maxTicketsPerPlayer,
      prizes: room.prizes
    });
  } else {
    res.json({ valid: false });
  }
});

// QR Code upload (per room)
app.post('/api/admin/:roomKey/upload-qr', upload.single('qrcode'), (req, res) => {
  const roomKey = req.params.roomKey.toUpperCase();
  const room = getRoom(roomKey);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  room.qrCodePath = '/uploads/' + req.file.filename;
  res.json({ success: true, path: room.qrCodePath });
});

// Get QR code (per room)
app.get('/api/:roomKey/qr-code', (req, res) => {
  const roomKey = req.params.roomKey.toUpperCase();
  const room = getRoom(roomKey);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({ path: room.qrCodePath });
});

// Admin login (per room)
app.post('/api/admin/:roomKey/login', (req, res) => {
  const roomKey = req.params.roomKey.toUpperCase();
  const room = getRoom(roomKey);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const { password } = req.body;
  if (password === room.adminPassword) {
    res.json({ success: true, token: 'admin-' + uuidv4(), roomKey });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

// Admin update settings (per room)
app.post('/api/admin/:roomKey/settings', (req, res) => {
  const roomKey = req.params.roomKey.toUpperCase();
  const room = getRoom(roomKey);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const { ticketPrice, maxTickets, prizes, autoCallSpeed, adminPassword } = req.body;
  if (ticketPrice) room.ticketPrice = ticketPrice;
  if (maxTickets) room.maxTicketsPerPlayer = maxTickets;
  if (autoCallSpeed) room.autoCallSpeed = autoCallSpeed;
  if (adminPassword) room.adminPassword = adminPassword;
  if (prizes) {
    Object.keys(prizes).forEach(key => {
      if (room.prizes[key]) {
        room.prizes[key].amount = prizes[key];
      }
    });
  }
  // Broadcast only to this room
  io.to(`room-${roomKey}`).emit('settingsUpdated', {
    ticketPrice: room.ticketPrice,
    prizes: room.prizes
  });
  res.json({ success: true });
});

// Get game state (per room)
app.get('/api/game/:roomKey/state', (req, res) => {
  const roomKey = req.params.roomKey.toUpperCase();
  const room = getRoom(roomKey);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const players = [];
  room.players.forEach((p, id) => {
    players.push({
      id: p.id,
      name: p.name,
      ticketCount: p.tickets.length,
      approved: p.approved,
      totalPaid: p.totalPaid
    });
  });
  res.json({
    roomKey,
    isGameActive: room.isGameActive,
    isGameStarted: room.isGameStarted,
    calledNumbers: room.calledNumbers,
    currentNumber: room.currentNumber,
    ticketPrice: room.ticketPrice,
    maxTicketsPerPlayer: room.maxTicketsPerPlayer,
    prizes: room.prizes,
    players,
    qrCodePath: room.qrCodePath
  });
});

// List active rooms (for debugging / admin overview)
app.get('/api/rooms', (req, res) => {
  const roomList = [];
  rooms.forEach((room, key) => {
    roomList.push({
      roomKey: key,
      playerCount: room.players.size,
      isGameStarted: room.isGameStarted,
      createdAt: room.createdAt
    });
  });
  res.json(roomList);
});

// Serve pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/game', (req, res) => res.sendFile(path.join(__dirname, 'public', 'game.html')));

// ==================== SOCKET.IO ====================
io.on('connection', (socket) => {
  console.log(`Connected: ${socket.id}`);
  let currentRoomKey = null; // Track which room this socket is in

  // Join a socket.io room
  socket.on('joinRoom', ({ roomKey, role }) => {
    roomKey = roomKey.toUpperCase();
    const room = getRoom(roomKey);
    if (!room) {
      socket.emit('roomError', { message: 'Room not found. Please check the room key.' });
      return;
    }

    currentRoomKey = roomKey;
    socket.join(`room-${roomKey}`);

    if (role === 'admin') {
      room.adminSockets.add(socket.id);
    }

    socket.emit('roomJoined', { roomKey });
    console.log(`Socket ${socket.id} joined room ${roomKey} as ${role}`);
  });

  // Player joins game (must be in a room first)
  socket.on('joinGame', ({ name, ticketCount, roomKey }) => {
    roomKey = (roomKey || currentRoomKey || '').toUpperCase();
    const room = getRoom(roomKey);
    if (!room) {
      socket.emit('roomError', { message: 'Room not found.' });
      return;
    }

    currentRoomKey = roomKey;
    socket.join(`room-${roomKey}`);

    const count = Math.min(ticketCount || 1, room.maxTicketsPerPlayer);
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
      room.tickets.set(ticketId, ticketData);
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

    room.players.set(socket.id, playerData);

    // Add to pending approvals
    room.pendingApprovals.set(playerId, {
      playerId,
      socketId: socket.id,
      name,
      ticketCount: count,
      totalAmount: count * room.ticketPrice,
      timestamp: Date.now()
    });

    socket.emit('joinedGame', {
      playerId,
      tickets: playerTickets,
      ticketPrice: room.ticketPrice,
      totalAmount: count * room.ticketPrice,
      prizes: room.prizes,
      qrCodePath: room.qrCodePath,
      approved: false,
      calledNumbers: room.calledNumbers,
      currentNumber: room.currentNumber,
      isGameStarted: room.isGameStarted,
      roomKey
    });

    // Notify only this room
    io.to(`room-${roomKey}`).emit('newPlayerJoined', {
      playerId,
      name,
      ticketCount: count,
      totalAmount: count * room.ticketPrice
    });

    io.to(`room-${roomKey}`).emit('playerListUpdated', getPlayerList(room));
  });

  // Admin approves player payment
  socket.on('approvePlayer', ({ playerId, roomKey }) => {
    roomKey = (roomKey || currentRoomKey || '').toUpperCase();
    const room = getRoom(roomKey);
    if (!room) return;

    let targetSocket = null;
    room.players.forEach((p, sid) => {
      if (p.id === playerId) {
        p.approved = true;
        p.totalPaid = p.tickets.length * room.ticketPrice;
        targetSocket = sid;
      }
    });

    room.pendingApprovals.delete(playerId);

    if (targetSocket) {
      io.to(targetSocket).emit('paymentApproved', { playerId });
    }

    io.to(`room-${roomKey}`).emit('playerListUpdated', getPlayerList(room));
    io.to(`room-${roomKey}`).emit('pendingApprovalsUpdated', getPendingApprovals(room));
  });

  // Admin rejects player
  socket.on('rejectPlayer', ({ playerId, roomKey }) => {
    roomKey = (roomKey || currentRoomKey || '').toUpperCase();
    const room = getRoom(roomKey);
    if (!room) return;

    let targetSocket = null;
    room.players.forEach((p, sid) => {
      if (p.id === playerId) {
        targetSocket = sid;
        p.tickets.forEach(t => room.tickets.delete(t.id));
        room.players.delete(sid);
      }
    });

    room.pendingApprovals.delete(playerId);

    if (targetSocket) {
      io.to(targetSocket).emit('paymentRejected', { playerId });
    }

    io.to(`room-${roomKey}`).emit('playerListUpdated', getPlayerList(room));
    io.to(`room-${roomKey}`).emit('pendingApprovalsUpdated', getPendingApprovals(room));
  });

  // Admin starts game
  socket.on('startGame', ({ roomKey } = {}) => {
    roomKey = (roomKey || currentRoomKey || '').toUpperCase();
    const room = getRoom(roomKey);
    if (!room) return;

    room.isGameActive = true;
    room.isGameStarted = true;
    room.calledNumbers = [];
    room.currentNumber = null;

    // Reset prizes
    Object.keys(room.prizes).forEach(key => {
      room.prizes[key].claimed = false;
      room.prizes[key].claimedBy = null;
    });

    io.to(`room-${roomKey}`).emit('gameStarted', {
      prizes: room.prizes
    });
  });

  // Admin calls next number
  socket.on('callNumber', ({ roomKey } = {}) => {
    roomKey = (roomKey || currentRoomKey || '').toUpperCase();
    const room = getRoom(roomKey);
    if (!room || !room.isGameStarted) return;

    const available = [];
    for (let i = 1; i <= 90; i++) {
      if (!room.calledNumbers.includes(i)) available.push(i);
    }

    if (available.length === 0) {
      io.to(`room-${roomKey}`).emit('gameComplete', { message: 'All numbers have been called!' });
      return;
    }

    const randomIndex = Math.floor(Math.random() * available.length);
    const number = available[randomIndex];

    room.calledNumbers.push(number);
    room.currentNumber = number;

    io.to(`room-${roomKey}`).emit('numberCalled', {
      number,
      calledNumbers: room.calledNumbers,
      remaining: available.length - 1
    });
  });

  // Admin starts auto-call
  socket.on('startAutoCall', ({ speed, roomKey } = {}) => {
    roomKey = (roomKey || currentRoomKey || '').toUpperCase();
    const room = getRoom(roomKey);
    if (!room) return;

    if (room.autoCallInterval) clearInterval(room.autoCallInterval);

    const callSpeed = speed || room.autoCallSpeed;
    room.autoCallSpeed = callSpeed;

    room.autoCallInterval = setInterval(() => {
      const available = [];
      for (let i = 1; i <= 90; i++) {
        if (!room.calledNumbers.includes(i)) available.push(i);
      }

      if (available.length === 0) {
        clearInterval(room.autoCallInterval);
        room.autoCallInterval = null;
        io.to(`room-${roomKey}`).emit('gameComplete', { message: 'All numbers have been called!' });
        return;
      }

      const randomIndex = Math.floor(Math.random() * available.length);
      const number = available[randomIndex];
      room.calledNumbers.push(number);
      room.currentNumber = number;

      io.to(`room-${roomKey}`).emit('numberCalled', {
        number,
        calledNumbers: room.calledNumbers,
        remaining: available.length - 1
      });
    }, callSpeed);

    io.to(`room-${roomKey}`).emit('autoCallStarted', { speed: callSpeed });
  });

  // Admin stops auto-call
  socket.on('stopAutoCall', ({ roomKey } = {}) => {
    roomKey = (roomKey || currentRoomKey || '').toUpperCase();
    const room = getRoom(roomKey);
    if (!room) return;

    if (room.autoCallInterval) {
      clearInterval(room.autoCallInterval);
      room.autoCallInterval = null;
    }
    io.to(`room-${roomKey}`).emit('autoCallStopped');
  });

  // Player claims prize
  socket.on('claimPrize', ({ playerId, ticketId, prizeType, roomKey }) => {
    roomKey = (roomKey || currentRoomKey || '').toUpperCase();
    const room = getRoom(roomKey);
    if (!room) return;

    const player = findPlayerById(room, playerId);
    if (!player || !player.approved) {
      socket.emit('claimResult', { success: false, message: 'Player not found or not approved' });
      return;
    }

    const ticket = room.tickets.get(ticketId);
    if (!ticket) {
      socket.emit('claimResult', { success: false, message: 'Ticket not found' });
      return;
    }

    if (room.prizes[prizeType]?.claimed) {
      socket.emit('claimResult', { success: false, message: 'This prize has already been claimed!' });
      return;
    }

    // Validate claim
    let isValid = false;
    const calledNumbers = room.calledNumbers;

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
      room.prizes[prizeType].claimed = true;
      room.prizes[prizeType].claimedBy = { name: player.name, playerId: player.id, ticketId };

      socket.emit('claimResult', {
        success: true,
        message: `🎉 Congratulations! You won ${prizeType}!`,
        prizeType,
        amount: room.prizes[prizeType].amount
      });

      io.to(`room-${roomKey}`).emit('prizeClaimed', {
        prizeType,
        playerName: player.name,
        amount: room.prizes[prizeType].amount,
        prizes: room.prizes
      });
    } else {
      socket.emit('claimResult', {
        success: false,
        message: 'Invalid claim! Your ticket does not qualify for this prize yet.'
      });

      // Notify admin of bogus claim
      io.to(`room-${roomKey}`).emit('bogusClaim', {
        playerName: player.name,
        playerId: player.id,
        prizeType,
        ticketId
      });
    }
  });

  // Admin resets game
  socket.on('resetGame', ({ roomKey } = {}) => {
    roomKey = (roomKey || currentRoomKey || '').toUpperCase();
    const room = getRoom(roomKey);
    if (!room) return;

    if (room.autoCallInterval) {
      clearInterval(room.autoCallInterval);
      room.autoCallInterval = null;
    }

    room.isGameActive = false;
    room.isGameStarted = false;
    room.calledNumbers = [];
    room.currentNumber = null;
    room.players.clear();
    room.tickets.clear();
    room.pendingApprovals.clear();

    Object.keys(room.prizes).forEach(key => {
      room.prizes[key].claimed = false;
      room.prizes[key].claimedBy = null;
    });

    io.to(`room-${roomKey}`).emit('gameReset');
  });

  // Admin ends current game (keeps players)
  socket.on('endGame', ({ roomKey } = {}) => {
    roomKey = (roomKey || currentRoomKey || '').toUpperCase();
    const room = getRoom(roomKey);
    if (!room) return;

    if (room.autoCallInterval) {
      clearInterval(room.autoCallInterval);
      room.autoCallInterval = null;
    }
    room.isGameStarted = false;
    io.to(`room-${roomKey}`).emit('gameEnded', { prizes: room.prizes });
  });

  // Admin deletes room
  socket.on('deleteRoom', ({ roomKey } = {}) => {
    roomKey = (roomKey || currentRoomKey || '').toUpperCase();
    const room = getRoom(roomKey);
    if (!room) return;

    if (room.autoCallInterval) clearInterval(room.autoCallInterval);
    io.to(`room-${roomKey}`).emit('gameReset');
    rooms.delete(roomKey);
    console.log(`🗑️ Room deleted: ${roomKey}`);
  });

  // Get pending approvals
  socket.on('getPendingApprovals', ({ roomKey } = {}) => {
    roomKey = (roomKey || currentRoomKey || '').toUpperCase();
    const room = getRoom(roomKey);
    if (!room) return;
    socket.emit('pendingApprovalsUpdated', getPendingApprovals(room));
  });

  // Get player list
  socket.on('getPlayerList', ({ roomKey } = {}) => {
    roomKey = (roomKey || currentRoomKey || '').toUpperCase();
    const room = getRoom(roomKey);
    if (!room) return;
    socket.emit('playerListUpdated', getPlayerList(room));
  });

  // Chat message (room-scoped)
  socket.on('chatMessage', ({ name, message, roomKey }) => {
    roomKey = (roomKey || currentRoomKey || '').toUpperCase();
    io.to(`room-${roomKey}`).emit('chatMessage', { name, message, timestamp: Date.now() });
  });

  // Disconnect
  socket.on('disconnect', () => {
    if (currentRoomKey) {
      const room = getRoom(currentRoomKey);
      if (room) {
        room.adminSockets.delete(socket.id);
        const player = room.players.get(socket.id);
        if (player) {
          console.log(`Player disconnected: ${player.name} from room ${currentRoomKey}`);
          io.to(`room-${currentRoomKey}`).emit('playerDisconnected', { name: player.name, playerId: player.id });
        }
      }
    }
  });

  // Reconnect
  socket.on('reconnect', ({ playerId, roomKey }) => {
    roomKey = (roomKey || currentRoomKey || '').toUpperCase();
    const room = getRoom(roomKey);
    if (!room) {
      socket.emit('reconnectFailed');
      return;
    }

    let found = false;
    room.players.forEach((p, oldSocketId) => {
      if (p.id === playerId) {
        // Update socket ID
        const playerData = room.players.get(oldSocketId);
        room.players.delete(oldSocketId);
        playerData.socketId = socket.id;
        room.players.set(socket.id, playerData);
        found = true;

        currentRoomKey = roomKey;
        socket.join(`room-${roomKey}`);

        socket.emit('reconnected', {
          playerId: playerData.id,
          tickets: playerData.tickets,
          approved: playerData.approved,
          calledNumbers: room.calledNumbers,
          currentNumber: room.currentNumber,
          prizes: room.prizes,
          isGameStarted: room.isGameStarted,
          roomKey
        });
      }
    });

    if (!found) {
      socket.emit('reconnectFailed');
    }
  });
});

// Helper functions
function findPlayerById(room, playerId) {
  let found = null;
  room.players.forEach(p => {
    if (p.id === playerId) found = p;
  });
  return found;
}

function getPlayerList(room) {
  const players = [];
  room.players.forEach((p) => {
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

function getPendingApprovals(room) {
  const approvals = [];
  room.pendingApprovals.forEach((a) => {
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
  console.log(`\n🏠 Rooms are created dynamically with unique keys\n`);
});
