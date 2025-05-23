const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Singleton pattern for database connection
let poolInstance = null;

/**
 * Database configuration 
 */
const getConfig = () => {
  return {
    host: process.env.DB_HOST || 'wynzio-db.ctgc2o26m8ys.us-east-2.rds.amazonaws.com',
    user: process.env.DB_USER || 'wynzio_admin',
    password: process.env.DB_PASSWORD || 'Wynzio$2025!',
    database: process.env.DB_NAME || 'wynzio',
    port: process.env.DB_PORT || 5432,
    ssl: {
      rejectUnauthorized: false
    }
  };
};

/**
 * Create database pool (Singleton pattern)
 */
const createPool = () => {
  if (!poolInstance) {
    poolInstance = new Pool(getConfig());
  }
  return poolInstance;
};

const pool = createPool();

/**
 * Test database connection
 * @returns {Promise<boolean>} Connection result
 */
async function testConnection() {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW() as now');
    const currentTime = result.rows[0].now;
    
    console.log(`Database connection successful as of ${currentTime}`);
    client.release();
    
    return true;
  } catch (error) {
    console.error('Database connection error:', error.message);
    console.error('Connection details:', {
      host: getConfig().host,
      user: getConfig().user,
      database: getConfig().database,
      port: getConfig().port,
      ssl: !!getConfig().ssl
    });
    
    return false;
  }
}

/**
 * Initialize database schema if needed
 * @returns {Promise<void>}
 */
async function initializeSchema() {
  try {
    const client = await pool.connect();
    
    // Check if database is already initialized by checking for users table
    const checkTableResult = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'users'
      );
    `);
    
    const tablesExist = checkTableResult.rows[0].exists;
    
    if (!tablesExist) {
      console.log('Database tables not found. Initializing schema...');
      
      // Read and execute schema file
      const schemaPath = path.join(__dirname, '../wynzio-database-schema.sql');
      if (fs.existsSync(schemaPath)) {
        const schema = fs.readFileSync(schemaPath, 'utf8');
        await client.query(schema);
        console.log('Database schema initialized successfully');
      } else {
        console.error('Schema file not found at:', schemaPath);
      }
    } else {
      console.log('Database tables already exist. Skipping initialization.');
      
      // Check if api_key exists in system_settings
      const apiKeyResult = await client.query(`
        SELECT EXISTS (
          SELECT FROM system_settings
          WHERE key = 'api_key'
        );
      `);
      
      if (!apiKeyResult.rows[0].exists) {
        console.log('API key not found in system settings. Adding default API key...');
        await client.query(`
          INSERT INTO system_settings (key, value, description)
          VALUES ('api_key', 'wynzio_default_key', 'Default API key for authentication')
        `);
        console.log('Default API key added to system settings');
      }
    }
    
    client.release();
  } catch (error) {
    console.error('Error initializing database schema:', error);
    throw error;
  }
}

module.exports = {
  pool,
  testConnection,
  initializeSchema
};