/**
 * Device API routes
 */
const express = require('express');
const router = express.Router();
const deviceController = require('../controllers/deviceController');
const authMiddleware = require('../middleware/auth');
const rbacMiddleware = require('../middleware/rbac');

/**
 * @route POST /api/devices/register
 * @desc Register a device
 * @access Public (with API key)
 */
router.post('/register', deviceController.registerDevice);

/**
 * @route GET /api/devices
 * @desc Get all devices
 * @access Private (admin, guest)
 */
router.get('/', 
  authMiddleware, 
  rbacMiddleware(['admin', 'guest'], ['view:devices']), 
  deviceController.getAllDevices
);

/**
 * @route GET /api/devices/online
 * @desc Get online devices
 * @access Private
 */
router.get('/online', 
  authMiddleware, 
  rbacMiddleware([], ['view:devices']), 
  deviceController.getOnlineDevices
);

/**
 * @route GET /api/devices/:deviceId
 * @desc Get device by ID
 * @access Private
 */
router.get('/:deviceId', 
  authMiddleware, 
  rbacMiddleware([], ['view:devices']), 
  deviceController.getDeviceById
);

/**
 * @route GET /api/devices/:deviceId/health
 * @desc Get device health
 * @access Private
 */
router.get('/:deviceId/health', 
  authMiddleware, 
  rbacMiddleware([], ['view:devices']), 
  deviceController.getDeviceHealth
);

/**
 * @route GET /api/devices/:deviceId/logs
 * @desc Get device logs
 * @access Private (admin)
 */
router.get('/:deviceId/logs', 
  authMiddleware, 
  rbacMiddleware(['admin'], ['view:logs']), 
  deviceController.getDeviceLogs
);

/**
 * @route POST /api/devices/:deviceId/connect
 * @desc Initiate connection to device
 * @access Private
 */
router.post('/:deviceId/connect', 
  authMiddleware, 
  rbacMiddleware([], ['control:devices']), 
  deviceController.initiateConnection
);

/**
 * @route GET /api/devices/system/health
 * @desc Get system health overview
 * @access Private (admin, guest)
 */
router.get('/system/health', 
  authMiddleware, 
  rbacMiddleware(['admin', 'guest'], ['view:settings']), 
  deviceController.getSystemHealth
);

module.exports = router;