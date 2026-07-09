import { Request, Response } from 'express';
import { TenantRequest } from '../middleware/tenant';
import Booking from '../models/Booking';
import Lead from '../models/Lead';
import Property from '../models/Property';
import BaseRepository from '../repositories/BaseRepository';
import { sendWhatsAppText } from '../services/whatsapp/whatsappService';
import { getIO } from '../services/socket/socketService';
import { getQueue } from '../services/queue/queueConfig';
import { sendEmail } from '../services/notificationService';

const bookingRepository = new BaseRepository(Booking);
const leadRepository = new BaseRepository(Lead);
const propertyRepository = new BaseRepository(Property);

export const getBookings = async (req: TenantRequest, res: Response) => {
  try {
    const tenantId = req.tenant?._id;
    if (!tenantId) return res.status(400).json({ message: 'Tenant context missing' });

    const bookings = await Booking.find({ tenantId })
      .populate('leadId', 'name mobile email status')
      .populate('propertyId', 'title location price');

    return res.status(200).json(bookings);
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};

export const createBookingRequest = async (req: TenantRequest, res: Response) => {
  try {
    const tenantId = req.tenant?._id;
    if (!tenantId) return res.status(400).json({ message: 'Tenant context missing' });

    const { leadId, propertyId, amount } = req.body;

    if (!leadId || !propertyId || !amount) {
      return res.status(400).json({ message: 'LeadId, propertyId, and amount are required' });
    }

    const lead = await leadRepository.findOne(tenantId, { _id: leadId });
    if (!lead) return res.status(404).json({ message: 'Lead not found' });

    const property = await propertyRepository.findOne(tenantId, { _id: propertyId });
    if (!property) return res.status(404).json({ message: 'Property not found' });

    const booking = await bookingRepository.create(tenantId, {
      leadId,
      propertyId,
      amount,
      status: 'Pending Approval',
    });

    lead.status = 'Ready to Buy';
    lead.timeline.push({
      event: 'Booking Requested',
      timestamp: new Date(),
      actor: (req as any).user?.role || 'Sales Executive',
      details: `Raised purchase request of â‚¹${amount.toLocaleString()} for property.`,
    });
    await lead.save();

    const io = getIO();
    if (io) {
      io.to('/crm').emit('lead:updated', lead);
    }

    return res.status(201).json(booking);
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};

export const approveBooking = async (req: TenantRequest, res: Response) => {
  try {
    const tenantId = req.tenant?._id;
    if (!tenantId) return res.status(400).json({ message: 'Tenant context missing' });

    const booking = await bookingRepository.findOne(tenantId, { _id: req.params.id });
    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    const lead = await leadRepository.findOne(tenantId, { _id: booking.leadId });
    if (!lead) return res.status(404).json({ message: 'Lead not found' });

    const property = await propertyRepository.findOne(tenantId, { _id: booking.propertyId });
    if (!property) return res.status(404).json({ message: 'Property not found' });

    booking.status = 'Paid';
    booking.paymentId = `cash_${Date.now()}`;
    booking.approvedBy = (req as any).user?.id;
    await booking.save();

    lead.status = 'Booked';
    lead.timeline.push({
      event: 'Booking Approved & Paid (Cash)',
      timestamp: new Date(),
      actor: 'Sales Manager',
      details: `Booking approved and recorded as Cash Payment of â‚¹${booking.amount.toLocaleString()}. Lead status set to Booked.`,
    });
    await lead.save();

    const checklistText = `Hello ${lead.name}, your booking request for *${property.title}* has been approved and recorded as cash payment! Welcome to the NextLead family!\n\nðŸ“‹ *Document Checklist needed:* \n1. PAN Card copy\n2. Aadhaar Card copy\n3. 3 months salary slips / tax returns\n4. Passport size photo.`;
    await sendWhatsAppText(lead._id.toString(), lead.mobile, checklistText);

    await sendEmail(
      lead._id.toString(),
      lead.email || 'customer@NextLead.com',
      'Booking Confirmed (Cash Payment Received) - NextLead',
      `Dear ${lead.name},\n\nYour purchase booking for ${property.title} has been approved and confirmed. We have successfully registered your cash token payment of â‚¹${booking.amount.toLocaleString()}.`
    );

    const io = getIO();
    if (io) {
      io.to('/crm').emit('lead:updated', lead);
      io.to('/crm').emit('booking:confirmed', {
        bookingId: booking._id,
        leadId: lead._id,
        amount: booking.amount,
        timestamp: new Date(),
      });
    }

    return res.status(200).json(booking);
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};

// Razorpay Payment Success Webhook (Public Route)
export const paymentWebhook = async (req: Request, res: Response) => {
  try {
    const payload = req.body;
    console.log('[Razorpay Webhook] Payload received:', JSON.stringify(payload));

    const bookingId = payload.bookingId || (payload.payload?.payment?.entity?.notes?.bookingId);
    const paymentId = payload.paymentId || (payload.payload?.payment?.entity?.id) || `pay_${Date.now()}`;

    if (!bookingId) {
      return res.status(400).json({ message: 'BookingId is required in payment webhook' });
    }

    // Resolve tenantId from the booking itself
    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    if (booking.status === 'Paid') {
      return res.status(200).json({ message: 'Already processed' });
    }

    booking.status = 'Paid';
    booking.paymentId = paymentId;
    await booking.save();

    const lead = await Lead.findById(booking.leadId);
    if (lead) {
      lead.status = 'Booked';
      lead.timeline.push({
        event: 'Booking Payment Successful',
        timestamp: new Date(),
        actor: 'System',
        details: `Confirmed Payment ID: ${paymentId}. Amount: â‚¹${booking.amount.toLocaleString()}. Lead status set to Booked.`,
      });
      await lead.save();

      const text = `Welcome to NextLead, ${lead.name}! ðŸ  Your booking is officially confirmed. We will keep you updated on construction updates here.`;
      await sendWhatsAppText(lead._id.toString(), lead.mobile, text);

      // Trigger drip welcome
      const emailQueue = getQueue('send-email');
      if (emailQueue) {
        await emailQueue.add('welcome-drip', {
          leadId: lead._id,
          to: lead.email,
          subject: 'Welcome to the NextLead Family!',
          text: `Hi ${lead.name},\n\nCongratulations on your property purchase. We have received your booking token payment.\n\nYour referral code is: REF-${lead._id.toString().substring(18)}.`
        });
      }

      const io = getIO();
      if (io) {
        io.to('/crm').emit('lead:updated', lead);
        io.to('/crm').emit('booking:confirmed', {
          bookingId: booking._id,
          leadId: lead._id,
          amount: booking.amount,
          timestamp: new Date(),
        });
      }
    }

    return res.status(200).json({ status: 'success', message: 'Booking confirmed via payment' });
  } catch (error: any) {
    return res.status(500).json({ message: error.message || 'Internal server error' });
  }
};
