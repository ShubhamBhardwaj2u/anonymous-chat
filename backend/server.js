const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Serve frontend folder
app.use(express.static(path.join(__dirname, 'frontend')));

// Serve index.html at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

// ---------- Socket.IO logic ----------
let waitingUser = null;
const activeChats = new Map(); // socketId -> partnerId

io.on('connection', socket => {
  console.log('User connected:', socket.id);

  socket.on('start_search', () => {
    if (activeChats.has(socket.id)) return;

    if (waitingUser && waitingUser !== socket.id) {
      const partner = waitingUser;
      waitingUser = null;

      activeChats.set(socket.id, partner);
      activeChats.set(partner, socket.id);

      socket.emit('matched');
      io.to(partner).emit('matched');
    } else {
      waitingUser = socket.id;
      socket.emit('searching');
    }
  });

  socket.on('send_message', msg => {
    const partner = activeChats.get(socket.id);
    if (partner) io.to(partner).emit('message', msg);
  });

  socket.on('end_chat', () => endSession(socket.id, 'chat_ended'));

  socket.on('disconnect', () => {
    endSession(socket.id, 'partner_left');
    if (waitingUser === socket.id) waitingUser = null;
    console.log('User disconnected:', socket.id);
  });

  function endSession(id, event) {
    const partner = activeChats.get(id);
    if (partner) io.to(partner).emit(event);
    if (partner) activeChats.delete(partner);
    activeChats.delete(id);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server running on port', PORT));
