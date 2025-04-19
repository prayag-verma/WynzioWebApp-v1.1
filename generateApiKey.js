/**
 * Generate API Key script for Wynzio
 * Creates a secure random API key and updates the configuration
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Generate a new secure random API key
function generateApiKey(length = 32) {
  return crypto.randomBytes(length).toString('hex');
}

// Path to config file
const configPath = path.join(__dirname, '../config/app.js');

// Generate new key
const newKey = generateApiKey();

// Read current config file
let configContent = fs.readFileSync(configPath, 'utf8');

// Replace key in config file with regex to handle different formats
configContent = configContent.replace(
  /(deviceApiKey:\s*(?:process\.env\.DEVICE_API_KEY\s*\|\|\s*)['"]).*?(['"])/,
  `$1${newKey}$2`
);

// Write updated config
fs.writeFileSync(configPath, configContent);

console.log('--------------------------------------------------');
console.log('              WYNZIO API KEY GENERATOR            ');
console.log('--------------------------------------------------');
console.log(`New API key generated: ${newKey}`);
console.log('Config file updated successfully');
console.log('--------------------------------------------------');
console.log('IMPORTANT: Save this key securely for your Windows application.');
console.log('You will need to include this key in your Windows app configuration.');
console.log('--------------------------------------------------');