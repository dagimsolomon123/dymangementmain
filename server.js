const express = require('express');
const http = require('http');
const socketIO = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: '*',
  },
});

// Root route for `/`
app.get('/', (req, res) => {
  res.send('<h1>Welcome to the Server</h1><p>This is the root route!</p>');
});

// Add a manual data route for Postman
app.get('/manual-data', (req, res) => {
  const manualData = {
    status: 'success',
    message: 'Here is some manual data!',
    data: [
      { id: 1, name: 'John Doe', role: 'Chef' },
      { id: 2, name: 'Jane Smith', role: 'Waiter' },
      { id: 3, name: 'Sam Wilson', role: 'Manager' },
    ],
    timestamp: new Date().toISOString(),
  };

  res.json(manualData);
});

// Socket.io connection logic
io.on('connection', (socket) => {
  console.log('New client connected');

  socket.on('sendData', (data) => {
    console.log('Received data:', data);
    socket.broadcast.emit('receiveData', data);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

// Start the server
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
