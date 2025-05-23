import express from 'express';
import { Router } from 'express';
import StripeController from './stripe.controller';
import auth from '../../../middlewares/auth';
import { userRole } from '../../../constents';

const router = Router();

router.post(
  '/create-checkout-session',
  auth([userRole.admin, userRole.user]),
  StripeController.createCheckoutSession
);

router.post(
  '/webhook',
  // Raw middleware required for signature verification
  // Ensure this is ONLY used here, not globally
  express.raw({ type: 'application/json' }),
  StripeController.handleWebhook
);

router.post(
    '/save-payment',
    StripeController.savePaymentManually
  );
  

export default router;
