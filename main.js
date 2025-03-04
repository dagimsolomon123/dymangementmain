const { app, BrowserWindow } = require('electron');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');
const bodyParser = require('body-parser');

// Initialize Express
const expressApp = express();
expressApp.use(bodyParser.json());

// Create database connection
const db = new sqlite3.Database('orders.db');

// Initialize database tables
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tableNumber TEXT,
    waiterName TEXT,
    order_items TEXT,
    status TEXT DEFAULT 'new',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    pending_start_time DATETIME,
    countdownData TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS waiters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    waiterName TEXT,
    passkey TEXT
  )`);
});

// Create an HTTP server with Express
const server = http.createServer(expressApp);
const io = socketIo(server, {
  cors: {
    origin: '*',
  }
});

// Listen on port 3000
server.listen(3000, () => {
  console.log('Server listening on port 3000');
});

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

io.on('connection', (socket) => {
  console.log('New client connected');

  // Send existing orders on connection
  db.all("SELECT * FROM orders WHERE status IN ('new', 'pending', 'completed')", (err, rows) => {
    if (err) {
      console.error('Error fetching existing orders:', err);
      return;
    }
    console.log('Existing orders:', rows);
    socket.emit('existingOrders', rows);
  });

  // Handle new order data
  socket.on('sendData', (data) => {
    console.log('Received data:', data);

    // Ensure order_items is a string
    if (Array.isArray(data.order)) {
      data.order_items = JSON.stringify(data.order);
    } else {
      data.order_items = data.order_items || '';
    }

    console.log('Data after string conversion:', data);

    // Store order in database
    db.run(
      'INSERT INTO orders (tableNumber, waiterName, order_items) VALUES (?, ?, ?)',
      [data.tableNumber, data.waiterName, data.order_items],
      function(err) {
        if (err) {
          console.error('Error inserting order:', err);
          return;
        }
        console.log('Order inserted with ID:', this.lastID);
        // Add the ID to the data object
        const orderWithId = { ...data, id: this.lastID, status: 'new' };
        // Emit the new order to all clients, including the sender
        io.emit('receiveData', orderWithId);
      }
    );
  });

  // Handle order status updates
  socket.on('updateOrderStatus', (data) => {
    const currentTime = new Date().toISOString();
    
    // If completing an order, calculate the countdown time
    if (data.status === 'completed') {
      db.get('SELECT pending_start_time FROM orders WHERE id = ?', [data.orderId], (err, row) => {
        if (err) {
          console.error('Error fetching order pending time:', err);
          return;
        }
        
        if (row && row.pending_start_time) {
          const countdownData = calculateCountdown(row.pending_start_time);
          
          db.run(
            'UPDATE orders SET status = ?, countdownData = ? WHERE id = ?',
            [data.status, countdownData, data.orderId],
            (err) => {
              if (err) {
                console.error('Error updating order status:', err);
                return;
              }
              io.emit('orderStatusUpdated', { 
                ...data, 
                countdownData: countdownData 
              });
            }
          );
        } else {
          // Fallback if no pending_start_time is found
          db.run(
            'UPDATE orders SET status = ? WHERE id = ?',
            [data.status, data.orderId],
            (err) => {
              if (err) {
                console.error('Error updating order status:', err);
                return;
              }
              io.emit('orderStatusUpdated', data);
            }
          );
        }
      });
    } else {
      // For non-completed status updates (like 'pending')
      db.run(
        'UPDATE orders SET status = ?, pending_start_time = ? WHERE id = ?',
        [data.status, currentTime, data.orderId],
        (err) => {
          if (err) {
            console.error('Error updating order status:', err);
            return;
          }
          io.emit('orderStatusUpdated', { ...data, pending_start_time: currentTime });
        }
      );
    }
  });

  // Handle completing an order
  socket.on('completeOrder', (orderId, callback) => {
    db.get('SELECT * FROM orders WHERE id = ?', [orderId], (err, row) => {
      if (err) {
        console.error('Error fetching order:', err);
        callback({ success: false, message: 'Error completing order' });
        return;
      }
      if (row) {
        const currentTime = new Date().toISOString();
        const countdownData = calculateCountdown(row.pending_start_time);
        db.run(
          'UPDATE orders SET status = ?, countdownData = ? WHERE id = ?',
          ['completed', countdownData, orderId],
          (err) => {
            if (err) {
              console.error('Error completing order:', err);
              callback({ success: false, message: 'Error completing order' });
              return;
            }
            io.emit('orderStatusUpdated', { orderId, status: 'completed', countdownData });
            callback({ success: true, message: 'Order completed successfully' });
          }
        );
      } else {
        callback({ success: false, message: 'Order not found' });
      }
    });
  });

  // Handle passkey verification
  socket.on('verifyPasskey', (passkey, callback) => {
    console.log('Received passkey:', passkey);
    db.get('SELECT * FROM waiters WHERE passkey = ?', [passkey], (err, row) => {
      if (err) {
        console.error('Error verifying passkey:', err);
        callback({ success: false, message: 'Error verifying passkey' });
        return;
      }
      if (row) {
        console.log('Passkey verified successfully for waiter:', row.waiterName);
        callback({ success: true });
      } else {
        console.log('Invalid passkey');
        callback({ success: false, message: 'Invalid passkey' });
      }
    });
  });

  // Handle getting waiter info
  socket.on('getWaiterInfo', (callback) => {
    db.get('SELECT * FROM waiters LIMIT 1', (err, row) => {
      if (err) {
        console.error('Error fetching waiter info:', err);
        callback({ waiterName: '', passkey: '' });
        return;
      }
      if (row) {
        callback({ waiterName: row.waiterName, passkey: row.passkey });
      } else {
        callback({ waiterName: '', passkey: '' });
      }
    });
  });

  // Handle fetching all pending orders
  socket.on('getAllPendingOrders', (callback) => {
    console.log('Received request for all pending orders');
    db.all('SELECT * FROM orders WHERE status = ?', ['pending'], (err, rows) => {
      if (err) {
        console.error('Error fetching pending orders:', err);
        callback([]);
        return;
      }
      console.log('Pending orders:', rows);
      callback(rows);
    });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

// Express routes
expressApp.get('/', (req, res) => {
  res.send('<h1>Welcome to the Server</h1><p>This is the root route!</p>');
  console.log('receiveData');
});

expressApp.get('/waiters', (req, res) => {
  db.all('SELECT * FROM waiters', (err, rows) => {
    if (err) {
      console.error('Error fetching waiters:', err);
      res.status(500).json({ success: false, message: 'Error fetching waiters' });
      return;
    }
    res.json(rows);
  });
});

expressApp.post('/waiters', (req, res) => {
  const { waitername, passkey } = req.body;
  db.run('INSERT INTO waiters (waiterName, passkey) VALUES (?, ?)', [waitername, passkey], function(err) {
    if (err) {
      console.error('Error inserting waiter:', err);
      res.status(500).json({ success: false, message: 'Error inserting waiter' });
      return;
    }
    res.json({ success: true, id: this.lastID });
  });
});

expressApp.delete('/waiters/:id', (req, res) => {
  const waiterId = req.params.id;
  db.run('DELETE FROM waiters WHERE id = ?', waiterId, function(err) {
    if (err) {
      console.error('Error deleting waiter:', err);
      res.status(500).json({ success: false, message: 'Error deleting waiter' });
      return;
    }
    res.json({ success: true });
  });
});

// Function to calculate the countdown time
function calculateCountdown(startTime) {
  const now = new Date().getTime();
  const start = new Date(startTime).getTime();
  const elapsed = now - start;

  const hours = Math.floor(elapsed / (1000 * 60 * 60));
  const minutes = Math.floor((elapsed % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((elapsed % (1000 * 60)) / 1000);

  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}
