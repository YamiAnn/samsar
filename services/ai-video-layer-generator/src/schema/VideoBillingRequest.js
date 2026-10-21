import mongoose, { Schema } from 'mongoose';

const schema = new Schema({
  _id: String,
  userId: { type: String, required: true, index: true },
  result: Schema.Types.Mixed,
  adapterReceipt: Schema.Types.Mixed,
  context: Schema.Types.Mixed,
  billing: { type: Schema.Types.Mixed, default: null },
  status: { type: String, default: 'PENDING', index: true },
  remainingCredits: Number,
}, { timestamps: true });

// Financial receipts have no queue TTL; pending debits survive job cleanup.
export default mongoose.models.VideoBillingRequest || mongoose.model('VideoBillingRequest', schema, 'video_billing_requests');
