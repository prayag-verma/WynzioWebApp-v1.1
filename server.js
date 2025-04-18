const express = require("express");
const http = require("http");
const cors = require("cors");
const path = require("path");
const { pool, testConnection, initializeSchema } = require("./config/db");

// Import configuration
const config = require("./config/app");

// Import routes
const authRoutes = require("./api/routes/auth");
const userRoutes = require("./api/routes/users");

// Create Express app
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Add cache control middleware for API responses
app.use((req, res, next) => {
  // Only apply to API routes
  if (req.path.startsWith('/api')) {
    // Use moderate cache control for APIs
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Pragma', 'no-cache');
  }
  next();
});

// Add database to request object
app.use((req, res, next) => {
  req.db = pool;
  req.config = config;
  next();
});

// API Routes
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);

// Static files - public directory with cache control
app.use(express.static("public", {
  etag: true, // Keep ETags for proper caching
  lastModified: true, // Use Last-Modified headers
  setHeaders: (res, path) => {
    // HTML files should use cache validation but not prevent caching
    if (path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Pragma', 'no-cache');
    } else if (path.endsWith('.js') || path.endsWith('.css')) {
      // JS and CSS files with short-lived cache (5 minutes)
      res.setHeader('Cache-Control', 'public, max-age=300');
    } else if (path.match(/\.(jpg|jpeg|png|gif|ico|svg)$/i)) {
      // Static assets can be cached longer (1 day)
      res.setHeader('Cache-Control', 'public, max-age=86400');
    } 
    // Default behavior for other resources
  }
}));

// Custom middleware to handle HTML5 history mode routing
app.use((req, res, next) => {
  if (req.method === 'GET' && 
      !req.path.startsWith('/api') && 
      !req.path.includes('.')) {
    
    if (req.path === '/') {
      // Add cache validation headers for index
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Pragma', 'no-cache');
      return res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
    
    // Map clean URLs to HTML files
    const routes = {
      '/login': '/views/login.html',
      '/dashboard': '/views/dashboard.html'
    };
    
    const filePath = routes[req.path];
    if (filePath) {
      // Add cache validation headers for application pages
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Pragma', 'no-cache');
      return res.sendFile(path.join(__dirname, 'public', filePath));
    }
  }
  next();
});

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date() });
});

// Catch-all route for handling 404s
app.use((req, res) => {
  // Check if request is for an HTML file
  if (req.accepts('html')) {
    // Add cache validation headers for 404 page
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Pragma', 'no-cache');
    res.status(404).sendFile(path.join(__dirname, "public", "404.html"));
    return;
  }
  
  // API requests
  res.status(404).json({
    success: false,
    message: "Resource not found"
  });
});

// Create HTTP server
const server = http.createServer(app);

// Database initialization and server startup
async function startServer() {
  try {
    // Test database connection
    const connected = await testConnection();
    
    if (!connected) {
      console.error("Cannot connect to database. Exiting...");
      process.exit(1);
    }
    
    // Initialize database schema if needed
    await initializeSchema();
    
    // Start server
    server.listen(config.port, () => {
      console.log(`Server running on port ${config.port}`);
      console.log(`Visit http://localhost:${config.port} to access the application`);
    });
  } catch (error) {
    console.error("Error starting server:", error);
    process.exit(1);
  }
}

// Start the server
startServer();

// Handle graceful shutdown
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

function shutdown() {
  console.log("Shutting down gracefully...");
  
  // Close server
  server.close(() => {
    console.log("HTTP server closed");
    
    // Close database pool
    pool.end(() => {
      console.log("Database pool closed");
      process.exit(0);
    });
  });
  
  // Force shutdown after 10 seconds
  setTimeout(() => {
    console.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10000);
}