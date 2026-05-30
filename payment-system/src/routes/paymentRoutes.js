const express = require('express');
const { create, getById, list, metrics } = require('../controllers/paymentController');
const { validateCreatePayment } = require('../middleware/validate');
const { createPaymentLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

router.post('/', createPaymentLimiter, validateCreatePayment, create);
router.get('/', list);
router.get('/:id', getById);

module.exports = router;
