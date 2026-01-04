const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);

// Configuration Socket.io optimisée pour Render et GitHub Pages
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  }
});

const PORT = process.env.PORT || 3000;
const rooms = {};

// --- FONCTIONS UTILITAIRES ---
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (rooms[code]);
  return code;
}

function findPlayerRoom(socketId) {
  for (const roomCode in rooms) {
    const room = rooms[roomCode];
    const player = room.players.find(p => p.socketId === socketId);
    if (player) return { room, player };
  }
  return null;
}

// --- LOGIQUE SOCKET.IO ---
io.on('connection', (socket) => {
  console.log('✅ Nouveau client connecté:', socket.id);

  socket.on('createRoom', () => {
    const roomCode = generateRoomCode();
    rooms[roomCode] = {
      code: roomCode,
      hostId: socket.id,
      players: [],
      gameState: {
        phase: 'lobby',
        crime: '',
        accusedId: null,
        evidences: [],
        votes: {}
      }
    };
    socket.join(roomCode);
    console.log('🎮 Room créée:', roomCode);
    socket.emit('roomCreated', { roomCode });
  });

  socket.on('joinRoom', ({ roomCode, playerName }) => {
    const room = rooms[roomCode];
    if (!room) {
      socket.emit('error', { message: 'Room introuvable' });
      return;
    }
    if (room.gameState.phase !== 'lobby') {
      socket.emit('error', { message: 'La partie a déjà commencé' });
      return;
    }
    const nameExists = room.players.some(p => p.name === playerName);
    if (nameExists) {
      socket.emit('error', { message: 'Ce pseudo est déjà pris' });
      return;
    }

    const playerId = `player-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const player = {
      id: playerId,
      name: playerName,
      socketId: socket.id,
      score: 0,
      evidenceSubmitted: false
    };

    room.players.push(player);
    socket.join(roomCode);
    socket.emit('joinedRoom', { roomCode, playerId });
    io.to(roomCode).emit('playerJoined', { players: room.players });
  });

  socket.on('startGame', ({ roomCode, crime, accusedId }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;

    const accused = room.players.find(p => p.id === accusedId);
    room.gameState.phase = 'evidence';
    room.gameState.crime = crime;
    room.gameState.accusedId = accusedId;
    room.gameState.evidences = [];
    room.gameState.votes = {};
    room.players.forEach(p => p.evidenceSubmitted = false);

    io.to(roomCode).emit('gameStarted', { crime, accused });
  });

  socket.on('changePhase', ({ roomCode, phase, timer }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;

    room.gameState.phase = phase;
    const data = { phase, timer };

    if (phase === 'trial') {
      data.evidences = room.gameState.evidences;
    } else if (phase === 'results') {
      room.gameState.evidences.forEach(evidence => {
        const player = room.players.find(p => p.id === evidence.playerId);
        if (player) {
          player.score += (evidence.votes || 0) * 3;
          const maxVotes = Math.max(...room.gameState.evidences.map(e => e.votes || 0));
          if (evidence.votes === maxVotes && maxVotes > 0) player.score += 5;
        }
      });
      data.scores = room.players.reduce((acc, p) => { acc[p.id] = p.score; return acc; }, {});
      data.evidences = room.gameState.evidences;
    }
    io.to(roomCode).emit('phaseChanged', data);
  });

  socket.on('submitEvidence', ({ roomCode, playerId, imageData, caption }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === playerId && p.socketId === socket.id);
    if (!player || player.evidenceSubmitted) return;

    const evidence = {
      id: `ev-${Date.now()}`,
      playerId,
      playerName: player.name,
      imageData,
      caption,
      votes: 0
    };

    room.gameState.evidences.push(evidence);
    player.evidenceSubmitted = true;
    io.to(roomCode).emit('evidenceSubmitted', { playerId });
    io.to(room.hostId).emit('playerJoined', { players: room.players });
  });

  socket.on('vote', ({ roomCode, playerId, evidenceId }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const evidence = room.gameState.evidences.find(e => e.id === evidenceId);
    if (evidence && evidence.playerId !== playerId) {
      if (room.gameState.votes[playerId]) {
        const oldEv = room.gameState.evidences.find(e => e.id === room.gameState.votes[playerId]);
        if (oldEv) oldEv.votes = Math.max(0, oldEv.votes - 1);
      }
      room.gameState.votes[playerId] = evidenceId;
      evidence.votes = (evidence.votes || 0) + 1;
      io.to(roomCode).emit('voteReceived', { evidenceId, playerId });
    }
  });

  socket.on('disconnect', () => {
    const result = findPlayerRoom(socket.id);
    if (result) {
      const { room, player } = result;
      if (room.hostId === socket.id) {
        io.to(room.code).emit('error', { message: 'Hôte déconnecté.' });
        delete rooms[room.code];
      } else {
        room.players = room.players.filter(p => p.socketId !== socket.id);
        io.to(room.code).emit('playerLeft', { players: room.players });
      }
    }
  });
});

// --- ROUTES EXPRESS ---
app.get('/', (req, res) => {
  res.json({ status: 'online', rooms: Object.keys(rooms).length });
});

// Nettoyage automatique
setInterval(() => {
  for (const code in rooms) {
    if (rooms[code].players.length === 0) delete rooms[code];
  }
}, 5 * 60 * 1000);

// ÉCOUTE DU SERVEUR (HTTP + SOCKET.IO)
server.listen(PORT, () => {
  console.log(`🚀 Serveur opérationnel sur le port ${PORT}`);
});
