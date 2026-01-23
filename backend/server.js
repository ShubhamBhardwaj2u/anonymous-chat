const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Serve frontend folder (index.html + static files)
app.use(express.static(path.join(__dirname, '../frontend')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend', 'index.html'));
});

// --- STATE ---
const waitingQueue = [];
const activeChats = new Map();    // socketId -> partnerId
const users = new Map();          // socketId -> { state: 'IDLE'|'SEARCHING'|'CONNECTED' }
const lastMessageTime = new Map();
const userTimers = new Map();
const typingTimers = new Map();
const disconnectedUsers = new Map(); // oldSocketId -> { state, partnerId, timer }

const USER_TIMEOUT = 2 * 60 * 1000;

function resetUserTimer(id) {
  if (userTimers.has(id)) clearTimeout(userTimers.get(id));
  userTimers.set(id, setTimeout(() => {
    const user = users.get(id);
    if (user) user.state = 'IDLE';
    endSession(id, 'chat_ended');
    console.log('Idle timeout reached for:', id);
  }, USER_TIMEOUT));
}

io.on('connection', socket => {
  console.log('User connected:', socket.id);
  users.set(socket.id, { state: 'IDLE' });

  // --- RECONNECT HANDLING ---
  socket.on('reconnect_attempt', oldId => {
    if (disconnectedUsers.has(oldId)) {
      const data = disconnectedUsers.get(oldId);
      clearTimeout(data.timer);

      users.set(socket.id, { state: data.state });

      if (data.partnerId) {
        activeChats.set(socket.id, data.partnerId);
        activeChats.set(data.partnerId, socket.id);
      }

      disconnectedUsers.delete(oldId);
      socket.emit('matched');
      if (data.partnerId) io.to(data.partnerId).emit('matched');

      console.log(`User ${oldId} reconnected as ${socket.id}`);
    }
  });

  // --- START SEARCH ---
  socket.on('start_search', () => {
    const user = users.get(socket.id);
    if (!user || user.state !== 'IDLE') return;

    user.state = 'SEARCHING';
    socket.emit('searching');
    resetUserTimer(socket.id);

    const partnerId = waitingQueue.find(id => id !== socket.id && users.has(id));
    if (partnerId) {
      waitingQueue.splice(waitingQueue.indexOf(partnerId), 1);
      activeChats.set(socket.id, partnerId);
      activeChats.set(partnerId, socket.id);
      users.get(socket.id).state = 'CONNECTED';
      users.get(partnerId).state = 'CONNECTED';
      socket.emit('matched');
      io.to(partnerId).emit('matched');

      if (userTimers.has(socket.id)) clearTimeout(userTimers.get(socket.id));
      if (userTimers.has(partnerId)) clearTimeout(userTimers.get(partnerId));

      console.log(`Matched ${socket.id} with ${partnerId}`);
    } else {
      waitingQueue.push(socket.id);
      console.log(`Added to queue: ${socket.id}`);
    }
  });

  // --- CANCEL SEARCH / END CHAT ---
  socket.on('cancel_search', () => {
    removeFromQueue(socket.id);
    const user = users.get(socket.id);
    if (user) user.state = 'IDLE';
    socket.emit('chat_ended');
  });

  socket.on('end_chat', () => endSession(socket.id, 'chat_ended'));

  // --- SEND MESSAGE ---
  socket.on('send_message', msg => {
    const user = users.get(socket.id);
    if (!user || user.state !== 'CONNECTED') return;
    const text = msg?.trim();
    if (!text || text.length > 500) return;

    const now = Date.now();
    const last = lastMessageTime.get(socket.id) || 0;
    if (now - last < 500) return;
    lastMessageTime.set(socket.id, now);

    const partnerId = activeChats.get(socket.id);
    if (partnerId) io.to(partnerId).emit('message', text);
  });

  // --- TYPING INDICATOR ---
  socket.on('typing', () => {
    const partnerId = activeChats.get(socket.id);
    if (partnerId) {
      io.to(partnerId).emit('typing');

      if (typingTimers.has(socket.id)) clearTimeout(typingTimers.get(socket.id));
      typingTimers.set(socket.id, setTimeout(() => {
        io.to(partnerId).emit('stop_typing');
        typingTimers.delete(socket.id);
      }, 1500));
    }
  });

  socket.on('stop_typing', () => {
    const partnerId = activeChats.get(socket.id);
    if (partnerId) io.to(partnerId).emit('stop_typing');
    if (typingTimers.has(socket.id)) {
      clearTimeout(typingTimers.get(socket.id));
      typingTimers.delete(socket.id);
    }
  });

  // --- DISCONNECT ---
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);

    const user = users.get(socket.id);
    if (user) {
      const partnerId = activeChats.get(socket.id);
      const timer = setTimeout(() => {
        disconnectedUsers.delete(socket.id);
        endSession(socket.id, 'partner_left');
      }, 2 * 60 * 1000); // 2 minutes

      disconnectedUsers.set(socket.id, { state: user.state, partnerId, timer });
    }

    if (typingTimers.has(socket.id)) clearTimeout(typingTimers.get(socket.id));
    typingTimers.delete(socket.id);
    activeChats.delete(socket.id);
    removeFromQueue(socket.id);
    lastMessageTime.delete(socket.id);
    users.delete(socket.id);
    if (userTimers.has(socket.id)) clearTimeout(userTimers.get(socket.id));
  });

  // --- HELPERS ---
  function endSession(id, event) {
    const partnerId = activeChats.get(id);

    if (partnerId) {
      io.to(partnerId).emit(event);
      const partner = users.get(partnerId);
      if (partner) partner.state = 'IDLE';
      activeChats.delete(partnerId);
    }

    io.to(id).emit(event);
    const user = users.get(id);
    if (user) user.state = 'IDLE';

    activeChats.delete(id);
    removeFromQueue(id);

    if (userTimers.has(id)) {
      clearTimeout(userTimers.get(id));
      userTimers.delete(id);
    }
  }

  function removeFromQueue(id) {
    const i = waitingQueue.indexOf(id);
    if (i !== -1) waitingQueue.splice(i, 1);
  }
});

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Server running on port', PORT);
});
