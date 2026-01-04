// server.js - Backend Socket.io pour "Le Procès Absurde"
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 3000;

const rooms = {};

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
    console.log('🎮 Room créée:', roomCode, 'par', socket.id);
    
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

    console.log('👤', playerName, 'a rejoint la room', roomCode);

    socket.emit('joinedRoom', { roomCode, playerId });
    io.to(roomCode).emit('playerJoined', { players: room.players });
  });

  socket.on('startGame', ({ roomCode, crime, accusedId }) => {
    const room = rooms[roomCode];

    if (!room || room.hostId !== socket.id) {
      socket.emit('error', { message: 'Non autorisé' });
      return;
    }

    if (room.players.length < 2) {
      socket.emit('error', { message: 'Il faut au moins 2 joueurs' });
      return;
    }

    const accused = room.players.find(p => p.id === accusedId);
    
    room.gameState.phase = 'evidence';
    room.gameState.crime = crime;
    room.gameState.accusedId = accusedId;
    room.gameState.evidences = [];
    room.gameState.votes = {};
    
    room.players.forEach(p => p.evidenceSubmitted = false);

    console.log('🎬 Partie démarrée dans', roomCode, ':', crime);

    io.to(roomCode).emit('gameStarted', {
      crime,
      accused
    });
  });

  socket.on('changePhase', ({ roomCode, phase, timer }) => {
    const room = rooms[roomCode];

    if (!room || room.hostId !== socket.id) {
      socket.emit('error', { message: 'Non autorisé' });
      return;
    }

    room.gameState.phase = phase;

    console.log('🔄 Phase changée dans', roomCode, ':', phase);

    const data = { phase, timer };

    if (phase === 'trial') {
      data.evidences = room.gameState.evidences;
    } else if (phase === 'results') {
      room.gameState.evidences.forEach(evidence => {
        const player = room.players.find(p => p.id === evidence.playerId);
        if (player) {
          player.score += (evidence.votes || 0) * 3;
          const maxVotes = Math.max(...room.gameState.evidences.map(e => e.votes || 0));
          if (evidence.votes === maxVotes && maxVotes > 0) {
            player.score += 5;
          }
        }
      });
      
      data.scores = room.players.reduce((acc, p) => {
        acc[p.id] = p.score;
        return acc;
      }, {});
      data.evidences = room.gameState.evidences;
    }

    io.to(roomCode).emit('phaseChanged', data);
  });

  socket.on('submitEvidence', ({ roomCode, playerId, imageData, caption }) => {
    const room = rooms[roomCode];

    if (!room) {
      socket.emit('error', { message: 'Room introuvable' });
      return;
    }

    const player = room.players.find(p => p.id === playerId && p.socketId === socket.id);
    
    if (!player) {
      socket.emit('error', { message: 'Joueur introuvable' });
      return;
    }

    if (player.evidenceSubmitted) {
      socket.emit('error', { message: 'Preuve déjà soumise' });
      return;
    }

    const evidenceId = `evidence-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    const evidence = {
      id: evidenceId,
      playerId,
      playerName: player.name,
      imageData,
      caption,
      votes: 0
    };

    room.gameState.evidences.push(evidence);
    player.evidenceSubmitted = true;

    console.log('📸', player.name, 'a soumis une preuve dans', roomCode);

    io.to(roomCode).emit('evidenceSubmitted', { playerId });
    io.to(room.hostId).emit('playerJoined', { players: room.players });
  });

  socket.on('vote', ({ roomCode, playerId, evidenceId }) => {
    const room = rooms[roomCode];

    if (!room) {
      socket.emit('error', { message: 'Room introuvable' });
      return;
    }

    const player = room.players.find(p => p.id === playerId && p.socketId === socket.id);
    
    if (!player) {
      socket.emit('error', { message: 'Joueur introuvable' });
      return;
    }

    const evidence = room.gameState.evidences.find(e => e.id === evidenceId);
    if (evidence && evidence.playerId === playerId) {
      socket.emit('error', { message: 'Tu ne peux pas voter pour ta propre preuve' });
      return;
    }

    if (room.gameState.votes[playerId]) {
      const oldEvidence = room.gameState.evidences.find(e => e.id === room.gameState.votes[playerId]);
      if (oldEvidence) {
        oldEvidence.votes = Math.max(0, oldEvidence.votes - 1);
      }
    }

    room.gameState.votes[playerId] = evidenceId;
    
    if (evidence) {
      evidence.votes = (evidence.votes || 0) + 1;
    }

    console.log('🗳️', player.name, 'a voté pour', evidenceId, 'dans', roomCode);

    io.to(roomCode).emit('voteReceived', { evidenceId, playerId });
  });

  socket.on('disconnect', () => {
    console.log('❌ Client déconnecté:', socket.id);

    const result = findPlayerRoom(socket.id);
    
    if (result) {
      const { room, player } = result;
      
      if (room.hostId === socket.id) {
        console.log('🚪 Host déconnecté, fermeture de la room', room.code);
        io.to(room.code).emit('error', { message: 'L\'hôte s\'est déconnecté. Partie terminée.' });
        delete rooms[room.code];
      } else {
        room.players = room.players.filter(p => p.socketId !== socket.id);
        console.log('👋', player.name, 'a quitté la room', room.code);
        io.to(room.code).emit('playerLeft', { players: room.players });
      }
    }
  });
});

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    rooms: Object.keys(rooms).length,
    message: 'Le Procès Absurde - Serveur Socket.io'
  });
});

app.get('/rooms', (req, res) => {
  const roomsInfo = Object.keys(rooms).map(code => ({
    code,
    players: rooms[code].players.length,
    phase: rooms[code].gameState.phase
  }));
  res.json({ rooms: roomsInfo });
});

server.listen(PORT, () => {
  console.log(`
  ╔════════════════════════════════════════╗
  ║   🎮 LE PROCÈS ABSURDE - SERVEUR 🎮   ║
  ╠════════════════════════════════════════╣
  ║  Serveur Socket.io en écoute...        ║
  ║  Port: ${PORT}                            ║
  ║  URL: http://localhost:${PORT}            ║
  ╚════════════════════════════════════════╝
  `);
});

setInterval(() => {
  for (const roomCode in rooms) {
    const room = rooms[roomCode];
    if (room.players.length === 0) {
      console.log('🧹 Nettoyage de la room vide:', roomCode);
      delete rooms[roomCode];
    }
  }
}, 5 * 60 * 1000);