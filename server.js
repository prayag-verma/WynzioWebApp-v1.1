const express = require("express");
const http = require("http");
const cors = require("cors");
const path = require("path");
const { pool, testConnection, initializeSchema } = require("./config/db");
const logger = require("./utils/logger");

// Import configuration
const config = require("./config/app");

// Import routes
const authRoutes = require("./api/routes/auth");
const userRoutes = require("./api/routes/users");
const deviceRoutes = require("./api/routes/devices");

// Import WebSocket services
const signalingService = require("./socket/signalingService");
const healthMonitor = require("./api/services/healthMonitor");

// Create Express app
const app = express();

// Middleware
app.use(cors({
  // Allow WebSocket connections from Windows app
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type']
}));

// Increase JSON payload size limit for larger data transfers
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// Add request logging middleware for debugging API requests
app.use((req, res, next) => {
  logger.debug(`${req.method} ${req.url}`, { 
    headers: req.headers,
    query: req.query,
    body: req.method === 'POST' || req.method === 'PUT' ? req.body : undefined
  });
  next();
});

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

// Extract remotePcId from URL for device-specific routes
app.use((req, res, next) => {
  const remotePcIdMatch = req.path.match(/\/api\/devices\/([^\/]+)/);
  if (remotePcIdMatch && remotePcIdMatch[1]) {
    req.remotePcId = remotePcIdMatch[1];
  }
  next();
});

// Add database to request object
app.use((req, res, next) => {
  req.db = pool;
  req.config = config;
  next();
});

// Make database available globally for socket auth
global.db = pool;

// CORS Preflight for all routes - handle OPTIONS requests
app.options('*', cors());

// *************** API ROUTES ***************
// These must be defined BEFORE static file handling

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date(), version: "1.0.0" });
});

// Mount API route handlers
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/devices", deviceRoutes);

// API 404 handler - specifically for API routes only
app.use('/api/*', (req, res) => {
  logger.warn(`API endpoint not found: ${req.method} ${req.url}`);
  res.status(404).json({
    success: false,
    message: "API endpoint not found"
  });
});

// *************** STATIC CONTENT HANDLING ***************
// Defined AFTER API routes to prevent conflicts

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
  // Skip API routes - they should have been handled above
  if (req.path.startsWith('/api/')) {
    return next();
  }
  
  if (req.method === 'GET' && !req.path.includes('.')) {
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
  
  // API requests that haven't been handled yet
  res.status(404).json({
    success: false,
    message: "Resource not found"
  });
});

// Create HTTP server
const server = http.createServer(app);

// Initialize Socket.IO server with existing HTTP server
// The signalingService should be configured to use the path '/signal/'
// to match Windows app expectations exactly
const io = signalingService.initialize(server, { path: '/signal/' });

// Database initialization and server startup
async function startServer() {
  try {
    // Test database connection
    const connected = await testConnection();
    
    if (!connected) {
      logger.error("Cannot connect to database. Exiting...");
      process.exit(1);
    }
    
    // Initialize database schema if needed
    await initializeSchema();
    
    // Start health monitoring service with aligned thresholds
    healthMonitor.startMonitoring(io);
    
    // Start server
    const port = process.env.PORT || config.port || 3000;
    server.listen(port, () => {
      logger.info(`Server running on port ${port}`);
      logger.info(`Visit http://localhost:${port} to access the application`);
      logger.info(`Socket.IO configured on path '/signal/' for Windows app compatibility`);
      
      // Log environment mode
      logger.info(`Running in ${process.env.NODE_ENV || 'production'} mode`);
    });
  } catch (error) {
    logger.error("Error starting server:", error);
    process.exit(1);
  }
}

// Start the server
startServer();

// Handle graceful shutdown
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

function shutdown() {
  logger.info("Shutting down gracefully...");
  
  // Stop health monitoring
  healthMonitor.stopMonitoring();
  
  // Close server
  server.close(() => {
    logger.info("HTTP server closed");
    
    // Close database pool
    pool.end(() => {
      logger.info("Database pool closed");
      process.exit(0);
    });
  });
  
  // Force shutdown after 10 seconds
  setTimeout(() => {
    logger.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10000);
}