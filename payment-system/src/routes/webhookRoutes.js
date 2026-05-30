const express = require('express');
const { handlePaymentWebhook } = require('../controllers/webhookController');
const { validateWebhookPayload } = require('../middleware/validate');

const router = express.Router();

router.post('/payment', validateWebhookPayload, handlePaymentWebhook);

module.exports = router;
