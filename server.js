const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

function createDeck() {
  let deck = [];
  for (let i = 1; i <= 12; i++) {
    for (let j = 0; j < i; j++) {
      deck.push(i);
    }
  }
  deck.push(13); // 어리광대 (Jester)
  deck.push(13); // 어리광대 (Jester)
  return shuffle(deck);
}

function shuffle(array) {
  return array.sort(() => Math.random() - 0.5);
}

let room = {
  players: [], // { id, name, hand: [] }
  gameStarted: false,
  turnIndex: 0,
  lastPlay: null,
  finishedPlayers: []
};

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // 현재 내 손패 요청 처리
  socket.on('getMyHand', () => {
    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      socket.emit('updateMyHand', player.hand);
    }
  });

  socket.on('joinGame', (nickname) => {
    if (room.gameStarted) {
      socket.emit('errorMessage', '이미 게임이 시작되었습니다.');
      return;
    }
    room.players.push({ id: socket.id, name: nickname, hand: [] });
    io.emit('updateRoom', room);
  });

  socket.on('startGame', () => {
    if (room.gameStarted) return;
    if (room.players.length < 3) {
      socket.emit('errorMessage', '최소 3명 이상이어야 시작할 수 있습니다.');
      return;
    }

    room.gameStarted = true;
    room.finishedPlayers = [];
    room.lastPlay = null;
    room.turnIndex = 0;

    const deck = createDeck();
    let pCount = room.players.length;

    room.players.forEach((player) => {
      player.hand = [];
    });
    deck.forEach((card, idx) => {
      room.players[idx % pCount].hand.push(card);
    });

    room.players.forEach((player) => {
      player.hand.sort((a, b) => a - b);
    });

    io.emit('gameStarted', room);
    notifyTurn();
  });

  socket.on('playCards', (selectedCards) => {
    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex !== room.turnIndex) {
      socket.emit('errorMessage', '당신의 차례가 아닙니다.');
      return;
    }

    const player = room.players[playerIndex];
    if (!selectedCards || selectedCards.length === 0) return;

    const cardRank = selectedCards[0];
    const isValidSameRank = selectedCards.every(c => c === cardRank);

    if (!isValidSameRank) {
      socket.emit('errorMessage', '같은 카드로만 낼 수 있습니다.');
      return;
    }

    if (room.lastPlay) {
      if (selectedCards.length !== room.lastPlay.count) {
        socket.emit('errorMessage', `카드를 ${room.lastPlay.count}장 내야 합니다.`);
        return;
      }
      if (cardRank >= room.lastPlay.rank) {
        socket.emit('errorMessage', `이전 카드(${room.lastPlay.rank})보다 낮은 숫자를 내야 합니다.`);
        return;
      }
    }

    selectedCards.forEach(c => {
      const idx = player.hand.indexOf(c);
      if (idx > -1) player.hand.splice(idx, 1);
    });

    room.lastPlay = {
      player: player.name,
      rank: cardRank,
      count: selectedCards.length,
      cards: selectedCards
    };

    if (player.hand.length === 0 && !room.finishedPlayers.includes(player.id)) {
      room.finishedPlayers.push(player.id);
      io.emit('chat', `${player.name} 님이 탈출했습니다!`);
    }

    if (room.finishedPlayers.length >= room.players.length - 1) {
      io.emit('gameOver', room.finishedPlayers);
      room.gameStarted = false;
      return;
    }

    nextTurn();
  });

  socket.on('passTurn', () => {
    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex !== room.turnIndex) return;
    nextTurn();
  });

  socket.on('disconnect', () => {
    room.players = room.players.filter(p => p.id !== socket.id);
    io.emit('updateRoom', room);
  });
});

function nextTurn() {
  do {
    room.turnIndex = (room.turnIndex + 1) % room.players.length;
  } while (room.players[room.turnIndex].hand.length === 0);

  notifyTurn();
}

function notifyTurn() {
  io.emit('turnUpdate', {
    turnPlayerId: room.players[room.turnIndex].id,
    turnPlayerName: room.players[room.turnIndex].name,
    lastPlay: room.lastPlay,
    players: room.players.map(p => ({ name: p.name, cardCount: p.hand.length, id: p.id }))
  });

  // 모든 플레이어에게 각자의 최신 손패를 전송
  room.players.forEach(p => {
    io.to(p.id).emit('updateMyHand', p.hand);
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
