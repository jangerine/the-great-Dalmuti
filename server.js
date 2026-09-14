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
  players: [], // { id, name, hand: [], rankTitle: '' }
  gameStarted: false,
  phase: 'WAITING', // WAITING, TAX, PLAYING
  turnIndex: 0,
  lastPlay: null,
  lastPlayPlayerId: null,
  passCount: 0,
  finishedPlayers: [], // [id, id, ...] 등수 순서
  taxState: {
    pendingTax: [] // 세금 주고받기 상태 관리
  }
};

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('getMyHand', () => {
    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      socket.emit('updateMyHand', { hand: player.hand, phase: room.phase, title: player.rankTitle });
    }
  });

  socket.on('joinGame', (nickname) => {
    if (room.gameStarted) {
      socket.emit('errorMessage', '이미 게임이 시작되었습니다.');
      return;
    }
    room.players.push({ id: socket.id, name: nickname, hand: [], rankTitle: '평민' });
    io.emit('updateRoom', room);
  });

  socket.on('startGame', () => {
    if (room.gameStarted) return;
    if (room.players.length < 3) {
      socket.emit('errorMessage', '최소 3명 이상이어야 시작할 수 있습니다.');
      return;
    }

    room.gameStarted = true;
    startNewRound();
  });

  // 세금 돌려주기 처리 (달무티가 농노에게 개똥같은 카드 돌려주기)
  socket.on('returnTaxCards', (selectedCards) => {
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    if (player.rankTitle === '대달무티' && selectedCards.length !== 2) {
      socket.emit('errorMessage', '대농노에게 줄 카드 2장을 선택해야 합니다.');
      return;
    }
    if (player.rankTitle === '소달무티' && selectedCards.length !== 1) {
      socket.emit('errorMessage', '소농노에게 줄 카드 1장을 선택해야 합니다.');
      return;
    }

    // 카드 이전 처리
    const targetTitle = player.rankTitle === '대달무티' ? '대농노' : '소농노';
    const targetPlayer = room.players.find(p => p.rankTitle === targetTitle);

    if (targetPlayer) {
      selectedCards.forEach(card => {
        const idx = player.hand.indexOf(card);
        if (idx > -1) {
          player.hand.splice(idx, 1);
          targetPlayer.hand.push(card);
        }
      });

      player.hand.sort((a, b) => a - b);
      targetPlayer.hand.sort((a, b) => a - b);

      room.taxState.pendingTax = room.taxState.pendingTax.filter(t => t !== player.rankTitle);
    }

    // 모든 세금 처리가 끝났는지 확인
    if (room.taxState.pendingTax.length === 0) {
      room.phase = 'PLAYING';
      io.emit('chat', '모든 세금 징수가 완료되었습니다! 라운드를 시작합니다.');
      notifyTurn();
    } else {
      notifyTaxPhase();
    }
  });

  socket.on('playCards', (selectedCards) => {
    if (room.phase !== 'PLAYING') return;

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

    room.passCount = 0;
    room.lastPlayPlayerId = player.id;

    selectedCards.forEach(c => {
      const idx = player.hand.indexOf(c);
      if (idx > -1) player.hand.splice(idx, 1);
    });

    room.lastPlay = {
      player: player.name,
      rank: cardRank,
      count: selectedCards.length,
      cards: selectedCards,
      playerId: player.id
    };

    if (player.hand.length === 0 && !room.finishedPlayers.includes(player.id)) {
      room.finishedPlayers.push(player.id);
      io.emit('chat', `🎉 ${player.name} 님이 ${room.finishedPlayers.length}등으로 탈출했습니다!`);
    }

    if (room.finishedPlayers.length >= room.players.length - 1) {
      // 남아있는 마지막 꼴찌 추가
      const lastPlayer = room.players.find(p => !room.finishedPlayers.includes(p.id));
      if (lastPlayer) room.finishedPlayers.push(lastPlayer.id);

      updateRanks();
      io.emit('gameOver', room.players.map(p => ({ name: p.name, title: p.rankTitle })));
      room.gameStarted = false;
      room.phase = 'WAITING';
      return;
    }

    nextTurn();
  });

  socket.on('passTurn', () => {
    if (room.phase !== 'PLAYING') return;

    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex !== room.turnIndex) return;

    if (room.lastPlay) {
      room.passCount++;
      const activePlayers = room.players.filter(p => p.hand.length > 0);
      
      if (room.passCount >= activePlayers.length - 1) {
        io.emit('chat', '모두가 패스했습니다! 바닥 카드가 리셋됩니다.');
        room.lastPlay = null;
        room.passCount = 0;

        const lastPlayerIndex = room.players.findIndex(p => p.id === room.lastPlayPlayerId);
        if (lastPlayerIndex !== -1 && room.players[lastPlayerIndex].hand.length > 0) {
          room.turnIndex = lastPlayerIndex;
          notifyTurn();
          return;
        }
      }
    }

    nextTurn();
  });

  socket.on('disconnect', () => {
    room.players = room.players.filter(p => p.id !== socket.id);
    io.emit('updateRoom', room);
  });
});

function startNewRound() {
  room.finishedPlayers = [];
  room.lastPlay = null;
  room.lastPlayPlayerId = null;
  room.passCount = 0;

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

  // 첫 판이 아니라 계급이 정해진 상태면 세금 계산 실행
  const hasRanks = room.players.some(p => p.rankTitle !== '평민');

  if (hasRanks && pCount >= 3) {
    room.phase = 'TAX';
    processAutomatedTax();
  } else {
    room.phase = 'PLAYING';
    room.turnIndex = 0;
    io.emit('gameStarted', room);
    notifyTurn();
  }
}

// 이전 판 등수 기반 계급 설정
function updateRanks() {
  const count = room.finishedPlayers.length;
  room.finishedPlayers.forEach((id, idx) => {
    const player = room.players.find(p => p.id === id);
    if (!player) return;

    if (idx === 0) player.rankTitle = '대달무티';
    else if (idx === 1 && count >= 4) player.rankTitle = '소달무티';
    else if (idx === count - 2 && count >= 4) player.rankTitle = '소농노';
    else if (idx === count - 1) player.rankTitle = '대농노';
    else player.rankTitle = '평민';
  });

  // 대달무티가 0번 인덱스(선)가 되도록 순서 배치
  const grandDalmutiIndex = room.players.findIndex(p => p.rankTitle === '대달무티');
  if (grandDalmutiIndex !== -1) {
    room.turnIndex = grandDalmutiIndex;
  }
}

// 농노들의 자동 세금 헌납 로직
function processAutomatedTax() {
  room.taxState.pendingTax = [];

  const grandDalmuti = room.players.find(p => p.rankTitle === '대달무티');
  const grandPeasant = room.players.find(p => p.rankTitle === '대농노');
  const littleDalmuti = room.players.find(p => p.rankTitle === '소달무티');
  const littlePeasant = room.players.find(p => p.rankTitle === '소농노');

  // 대농노 -> 대달무티 (가장 좋은 카드 2장 바침)
  if (grandDalmuti && grandPeasant) {
    const bestCards = grandPeasant.hand.splice(0, 2); // 1번 쪽에 가까운 가장 작은 카드 2장
    grandDalmuti.hand.push(...bestCards);
    grandDalmuti.hand.sort((a, b) => a - b);
    room.taxState.pendingTax.push('대달무티');
  }

  // 소농노 -> 소달무티 (가장 좋은 카드 1장 바침)
  if (littleDalmuti && littlePeasant) {
    const bestCard = littlePeasant.hand.splice(0, 1);
    littleDalmuti.hand.push(...bestCard);
    littleDalmuti.hand.sort((a, b) => a - b);
    room.taxState.pendingTax.push('소달무티');
  }

  notifyTaxPhase();
}

function notifyTaxPhase() {
  io.emit('taxPhaseUpdate', {
    pendingTax: room.taxState.pendingTax,
    players: room.players.map(p => ({ name: p.name, title: p.rankTitle }))
  });

  room.players.forEach(p => {
    io.to(p.id).emit('updateMyHand', { hand: p.hand, phase: 'TAX', title: p.rankTitle });
  });
}

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
    players: room.players.map(p => ({ name: p.name, cardCount: p.hand.length, id: p.id, title: p.rankTitle }))
  });

  room.players.forEach(p => {
    io.to(p.id).emit('updateMyHand', { hand: p.hand, phase: 'PLAYING', title: p.rankTitle });
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
