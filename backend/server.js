const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Serve frontend folder
app.use(express.static(path.join(__dirname, '../frontend')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend', 'index.html'));
});

// --- STATE ---
const waitingQueue = [];
const activeChats = new Map();
const users = new Map();
const lastMessageTime = new Map();
const userTimers = new Map();
const typingTimers = new Map();

// --- SAFETY STATE (PHASE 2) ---
const ipReportCounters = new Map(); // ip -> { count, resetAt }
const ipCooldowns = new Map();      // ip -> cooldownUntil

// --- LIMITS ---
//const USER_TIMEOUT = 2 * 60 * 1000;
const USER_TIMEOUT = 10 * 1000;
const REPORT_LIMIT = 3;
const REPORT_WINDOW = 60 * 60 * 1000;
const COOLDOWN_TIME = 60 * 1000;

	function resetUserTimer(id) {
	  if (userTimers.has(id)) {
		clearTimeout(userTimers.get(id));
	  }

	  userTimers.set(
		id,
		setTimeout(() => {
		  const user = users.get(id);
		  if (user) user.state = 'IDLE';
		  endSession(id, 'chat_ended');
		  console.log('Idle timeout reached for:', id);
		}, USER_TIMEOUT)
	  );
	}


	// --- CHECKING IP STATUS ---
	function isInCooldown(ip) {
	  const until = ipCooldowns.get(ip);
	  return until && until > Date.now();
	}
	
	// --- BLOCKING IP ---
	function applyCooldown(ip) {
	  ipCooldowns.set(ip, Date.now() + COOLDOWN_TIME);
	}

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
    const index = waitingQueue.indexOf(id);
    if (index !== -1) {
      waitingQueue.splice(index, 1);
    }
  }

// --- SOCKET.IO CONNECTION ---
io.on('connection', socket => {
	const ip =
    socket.handshake.headers['x-forwarded-for']?.split(',')[0] ||
    socket.handshake.address;
	
  console.log('User connected:', socket.id);
  users.set(socket.id, { state: 'IDLE', ip });

  // ✅ ADDITION: notify blocked user immediately (no disconnect)
  if (isInCooldown(ip)) {
    socket.emit(
      'system_notice',
      'You have been reported. Please wait before starting a new chat.'
    );
  }
  
  // --- START SEARCH ---
  socket.on('start_search', () => {
    if (isInCooldown(ip)) {
      socket.emit(
        'system_notice',
        'You have been reported. Please wait before starting a new chat.'
      );
      return;
    }    
	
	const user = users.get(socket.id);
    if (!user || user.state !== 'IDLE') return;

    user.state = 'SEARCHING';
    socket.emit('searching');
    resetUserTimer(socket.id);

    console.log('User started search:', socket.id);

    const partnerId = waitingQueue.find(
      id => id !== socket.id && users.has(id)
    );

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

  // --- CANCEL SEARCH ---
  socket.on('cancel_search', () => {
    removeFromQueue(socket.id);

    const user = users.get(socket.id);
    if (user) user.state = 'IDLE';

    socket.emit('chat_ended');
    console.log('User canceled search:', socket.id);
  });
  
  // --- REPORT USER ---
  socket.on('report_user', () => {
	  const user = users.get(socket.id);

// ------------------------------------------------ restrict reporting user --------------------------------------------    
	if (!user) return;

    const now = Date.now();
    const entry = ipReportCounters.get(ip) || {
      count: 0,
      resetAt: now + REPORT_WINDOW
    };

    if (now > entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + REPORT_WINDOW;
    }

    if (entry.count >= REPORT_LIMIT) {
      return;
    }

    entry.count += 1;
    ipReportCounters.set(ip, entry);
// -----------------------------------------------------------------------------------------------------    
	
	
	  const partnerId = activeChats.get(socket.id);
	  if (partnerId) {
		  const partner = users.get(partnerId);
		  if (partner && partner.ip) {
			applyCooldown(partner.ip);
			io.to(partnerId).emit(
			  'system_notice',
			  'You have been reported. Please wait before starting a new chat.'
			);
		  }
		}
		
	  // End chat for both users
	  endSession(socket.id, 'chat_ended');

	  console.log('User reported:', partnerId, 'by', socket.id);
	});


  // --- END CHAT ---
  socket.on('end_chat', () => {
    endSession(socket.id, 'chat_ended');
    console.log('User ended chat:', socket.id);
  });

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
    if (partnerId) {
      io.to(partnerId).emit('message', text);
      // Intentionally no logging of message content
    }
  });

  // --- TYPING INDICATOR ---
  socket.on('typing', () => {
    const partnerId = activeChats.get(socket.id);
    if (!partnerId) return;

    io.to(partnerId).emit('typing');

    if (typingTimers.has(socket.id)) {
      clearTimeout(typingTimers.get(socket.id));
    }

    typingTimers.set(
      socket.id,
      setTimeout(() => {
        io.to(partnerId).emit('stop_typing');
        typingTimers.delete(socket.id);
      }, 1500)
    );
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
    if (typingTimers.has(socket.id)) {
      clearTimeout(typingTimers.get(socket.id));
      typingTimers.delete(socket.id);
    }

    endSession(socket.id, 'partner_left');
    removeFromQueue(socket.id);
    lastMessageTime.delete(socket.id);
    users.delete(socket.id);

    if (userTimers.has(socket.id)) {
      clearTimeout(userTimers.get(socket.id));
    }

    console.log('User disconnected:', socket.id);
  });

});

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Server running on port', PORT);
});
