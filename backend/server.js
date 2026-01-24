const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Serve frontend folder
app.use(express.static(path.join(__dirname, '../frontend')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend', 'index.html'));
});

// Temporary endpoint to view feedback logs (REMOVE AFTER TESTING FOR SECURITY)
app.get('/logs', (req, res) => {
  try {
    const logs = fs.readFileSync('feedback.log', 'utf8');
    res.type('text/plain').send(logs || 'No logs available.');
  } catch (err) {
    res.status(500).send('Error reading logs: ' + err.message);
  }
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
const feedbackLimits = new Map();  // ip -> lastFeedbackDate (YYYY-MM-DD)

// --- LIMITS ---
//const USER_TIMEOUT = 2 * 60 * 1000;
const USER_TIMEOUT = 2 * 60 * 1000;
const COOLDOWN_TIME = 5 * 60 * 1000;

// A person can report 3 times in an hour. If they want to report more, they need to wait for the hour to reset.
const REPORT_LIMIT = 3;
const REPORT_WINDOW = 60 * 60 * 1000; // 1 hour

const FEEDBACK_FILE = 'feedback.log';  // File to store feedback

	// Helper to get today's date as string
	function getToday() {
	  return new Date().toISOString().split('T')[0];
	}

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
      io.to(partnerId).emit('partner_left');

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
	  //console.log(`Removing User from queue ${id}`);
	  const index = waitingQueue.indexOf(id);
	  //console.log(`[DEBUG] Checking queue for ${id}`);
	  //console.log(`[DEBUG] Current waitingQueue: [${waitingQueue.join(', ')}]`);
	  //console.log(`[DEBUG] Index of ${id}: ${index}`);
	  if (index !== -1) {
		//console.log(`[DEBUG] Removing from queue: ${id}`);
		waitingQueue.splice(index, 1);
		console.log(`Removed from queue ${id}`);
		//console.log(`[DEBUG] Updated waitingQueue: [${waitingQueue.join(', ')}]`);
	  } else {
		//console.log(`[DEBUG] ${id} not in queue - no removal needed (expected for active users)`);
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
  // 1. Cooldown / report check
  if (isInCooldown(ip)) {
    socket.emit(
      'system_notice',
      'You have been reported. Please wait before starting a new chat.'
    );
    return;
  }

  // 2. Validate user
  const user = users.get(socket.id);
  if (!user || user.state !== 'IDLE') {
    console.log('Invalid start_search from:', socket.id);
    return;
  }

  // 3. Mark user as searching
  user.state = 'SEARCHING';
  socket.emit('searching');
  resetUserTimer(socket.id);

  console.log('User started search:', socket.id);
  //console.log('[DEBUG] Queue before:', waitingQueue);

  // 4. Find a valid partner from queue
  const partnerId = waitingQueue.find(id => {
    const partner = users.get(id);
    return partner && partner.state === 'SEARCHING' && id !== socket.id;
  });

  // 5. If partner found → match
  if (partnerId) {
    // Remove partner from queue
    waitingQueue.splice(waitingQueue.indexOf(partnerId), 1);

    // Map active chat
    activeChats.set(socket.id, partnerId);
    activeChats.set(partnerId, socket.id);

    // Update states
    users.get(socket.id).state = 'CONNECTED';
    users.get(partnerId).state = 'CONNECTED';

    // Notify both users
    socket.emit('matched');
    io.to(partnerId).emit('matched');

    // Clear timers
    if (userTimers.has(socket.id)) clearTimeout(userTimers.get(socket.id));
    if (userTimers.has(partnerId)) clearTimeout(userTimers.get(partnerId));

    console.log(`Matched ${socket.id} with ${partnerId}`);
    //console.log('[DEBUG] Queue after match:', waitingQueue);
  }
  // 6. If no partner → add to queue
  else {
    waitingQueue.push(socket.id);
    const index = waitingQueue.indexOf(socket.id);

    console.log(`Added to queue: ${socket.id}`);
    //console.log('[DEBUG] Queue position:', index);
    //console.log('[DEBUG] Queue after enqueue:', waitingQueue);
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
  console.log('[REPORT] Report event received from:', socket.id);

  // Fetch reporting user
  const user = users.get(socket.id);
  if (!user) {
    console.log('[REPORT] User not found for socket:', socket.id);
    return;
  }

  // -------------------- REPORT ABUSE PROTECTION (IP BASED) --------------------
  const now = Date.now();

  const entry = ipReportCounters.get(ip) || {
    count: 0,
    resetAt: now + REPORT_WINDOW
  };

  // Reset counter if time window expired
  if (now > entry.resetAt) {
    console.log('[REPORT] Report window reset for IP:', ip);
    entry.count = 0;
    entry.resetAt = now + REPORT_WINDOW;
  }

  // Block report if limit exceeded - NEW: Emit feedback to reporter and stop
  if (entry.count >= REPORT_LIMIT) {
    console.log('[REPORT] Report limit exceeded for IP:', ip);
    socket.emit('report_feedback', false);
    return;  // Do nothing else - no reporting, no chat ending
  }

  // Increment report count (only if not exceeded)
  entry.count += 1;
  ipReportCounters.set(ip, entry);

  console.log('[REPORT] Report count for IP:', ip, '=>', entry.count);
  // ---------------------------------------------------------------------------

  // Get active chat partner
  const partnerId = activeChats.get(socket.id);
  console.log('[REPORT] Partner socket ID:', partnerId);

  if (partnerId) {
    const partner = users.get(partnerId);

    if (partner && partner.ip) {
      console.log('[REPORT] Applying cooldown to IP:', partner.ip);

      // Apply cooldown to reported user
      applyCooldown(partner.ip);

      // Notify reported user
      io.to(partnerId).emit(
        'system_notice',
        'You have been reported. Please wait before starting a new chat.'
      );

      console.log('[REPORT] System notice sent to:', partnerId);
    } else {
      console.log('[REPORT] Partner user or IP not found:', partnerId);
    }
  } else {
    console.log('[REPORT] No active chat found for reporter:', socket.id);
  }

  // End chat session for both users
  console.log('[REPORT] Ending chat session for reporter:', socket.id);
  endSession(socket.id, 'chat_ended');
  socket.emit('report_feedback', true);
  console.log('[REPORT] Report completed. Reporter:', socket.id, 'Reported:', partnerId);
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
  
	// --- SUBMIT FEEDBACK ---
	socket.on('submit_feedback', text => {
	  const ip = socket.handshake.headers['x-forwarded-for']?.split(',')[0] || socket.handshake.address;
	  const today = getToday();
	  const lastDate = feedbackLimits.get(ip);

	  if (lastDate === today) {
		socket.emit('feedback_result', false);  // Limit exceeded
		return;
	  }

	  // Log feedback (anonymously, with IP for moderation if needed)
	  const entry = `[${new Date().toISOString()}] IP: ${ip} - Feedback: ${text}\n`;
	  fs.appendFile(FEEDBACK_FILE, entry, err => {
		if (err) console.error('Error logging feedback:', err);
	  });

	  feedbackLimits.set(ip, today);
	  socket.emit('feedback_result', true);  // Success
	  console.log('Feedback submitted from IP:', ip);
	});

});

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Server running on port', PORT);
});
