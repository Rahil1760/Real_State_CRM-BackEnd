import { Worker } from 'bullmq';
import { getConnection, getQueue } from './queueConfig';
import Lead from '../../models/Lead';
import Property from '../../models/Property';
import Tenant from '../../models/Tenant';
import LeadImportBatch from '../../models/LeadImportBatch';
import ProjectDocument from '../../models/ProjectDocument';
import DocumentChunk from '../../models/DocumentChunk';
import mongoose from 'mongoose';
import path from 'path';
import Fuse from 'fuse.js';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import pdfParse from 'pdf-parse';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { processAIConversation, searchProperties, scoreLeadPostVisit } from '../ai/aiService';
import { sendWhatsAppText, sendWhatsAppTemplate } from '../whatsapp/whatsappService';
import { sendEmail, sendSMS } from '../notificationService';
import { getIO } from '../socket/socketService';
import { generateQueryEmbedding } from '../ai/aiTools';

export const initWorkers = () => {
  const connection = getConnection();

  // 1. Qualify Lead Worker
  const qualifyWorker = new Worker(
    'qualify-lead',
    async (job) => {
      const { leadId, message } = job.data;
      const lead = await Lead.findById(leadId);
      if (!lead) return;

      if (job.name === 'qualify') {
        // First initialization conversation greeting
        lead.status = 'Qualifying';
        await lead.save();

        const properties = await Property.find({ tenantId: lead.tenantId });

        const availableLocations = properties
          .map(property => property.location)
          .filter((location, index, arr) => arr.indexOf(location) === index)
          .join(", ");

        const tenantObj = await Tenant.findById(lead.tenantId).select('name');
        const companyName = tenantObj ? tenantObj.name : 'our platform';

        const greeting = `Hello ${lead.name || "there"}! 👋 Welcome to ${companyName}. I am Kayra, your AI assistant. I'll help you find the perfect property.

        🏘️ Currently, we have projects available in: ${availableLocations}.`;

        // const greeting = `Hello ${lead.name || 'there'}! Welcome to NextLead. I am Kayra your AI assistant. I'll help match you with the perfect property. Could you please share your budget, preferred location, property type (Apartment, Villa, Plot, or Commercial), and whether you are buying or investing?`;

        await sendWhatsAppText(lead._id.toString(), lead.mobile, greeting);
      } else if (job.name === 'conversation-turn') {
        // Run AI text analysis turn
        await processAIConversation(leadId, message);
      }
    },
    { connection }
  );

  // 2. WhatsApp Sender Worker
  const whatsappWorker = new Worker(
    'send-whatsapp',
    async (job) => {
      const { leadId, to, text, templateName, parameters } = job.data;
      if (templateName) {
        await sendWhatsAppTemplate(leadId, to, templateName, parameters);
      } else {
        await sendWhatsAppText(leadId, to, text);
      }
    },
    { connection }
  );

  // 3. Email Sender Worker
  const emailWorker = new Worker(
    'send-email',
    async (job) => {
      const { leadId, to, subject, text } = job.data;
      await sendEmail(leadId, to, subject, text);
    },
    { connection }
  );

  // 4. SMS Sender Worker
  const smsWorker = new Worker(
    'send-sms',
    async (job) => {
      const { leadId, to, text } = job.data;
      await sendSMS(leadId, to, text);
    },
    { connection }
  );

  // 5. Follow Up & Re-engagement Worker
  const followUpWorker = new Worker(
    'follow-up',
    async (job) => {
      const { leadId } = job.data;
      const lead = await Lead.findById(leadId);
      if (!lead) return;

      if (job.name === 'reminder-24h') {
        if (lead.status === 'Incomplete') {
          const msg = `Hi ${lead.name}, just checking in! Would you like to complete your property search profile? We have new listings available.`;
          await sendWhatsAppText(lead._id.toString(), lead.mobile, msg);

          lead.timeline.push({
            event: '24h Follow-up Sent',
            timestamp: new Date(),
            actor: 'System',
            details: 'Auto qualified reminder sent via WhatsApp.',
          });
          await lead.save();
        }
      } else if (job.name === 're-engage-3d') {
        const msg = `Hello ${lead.name}, we've added new premium properties in ${lead.location || 'your preferred areas'}. Are you interested in taking a look?`;
        await sendWhatsAppText(lead._id.toString(), lead.mobile, msg);

        lead.timeline.push({
          event: '3d Follow-up Re-engagement',
          timestamp: new Date(),
          actor: 'System',
          details: 'Re-engagement message sent.',
        });
        await lead.save();
      } else if (job.name === 'property-match') {
        const properties = await searchProperties(lead.tenantId.toString());
        if (properties.length > 0) {
          const prop = properties[0];
          const text = `Hi ${lead.name}, we found a property match: *${prop.title}* at ${prop.location} for â‚¹${prop.price.toLocaleString()}.\nBrochure: ${prop.s3Urls.brochure || 'http://mock-s3.com/brochure.pdf'}\nWould you like to schedule a site visit?`;
          await sendWhatsAppText(lead._id.toString(), lead.mobile, text);
        }
      }
    },
    { connection }
  );

  // 6. Score Lead Worker
  const scoreWorker = new Worker(
    'score-lead',
    async (job) => {
      const { leadId, feedback } = job.data;
      await scoreLeadPostVisit(leadId, feedback);
    },
    { connection }
  );

  // 7. Lead Import Worker
  const leadImportWorker = new Worker(
    'lead-import',
    async (job) => {
      const { batchId, tenantId, filePath, mapping, dedupeMode } = job.data;
      const batch = await LeadImportBatch.findOne({ batchId, tenantId });
      if (!batch) {
        console.error(`[Lead Import] Batch not found: ${batchId}`);
        return;
      }

      const io = getIO();
      const qualifyQueue = getQueue('qualify-lead');
      const whatsappQueue = getQueue('send-whatsapp');

      try {
        const fs = require('fs');
        if (!fs.existsSync(filePath)) {
          throw new Error(`File not found at path: ${filePath}`);
        }

        const ext = path.extname(filePath).toLowerCase();
        let rows: any[][] = [];

        if (ext === '.csv') {
          const fileContent = fs.readFileSync(filePath, 'utf8');
          const parseResult = Papa.parse(fileContent, { header: false, skipEmptyLines: true });
          rows = parseResult.data as any[][];
        } else if (ext === '.xlsx' || ext === '.xls') {
          const workbook = XLSX.readFile(filePath);
          const sheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[sheetName];
          rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];
        } else {
          throw new Error(`Unsupported file extension: ${ext}`);
        }

        if (rows.length <= 1) {
          throw new Error('Import file is empty or has no data rows');
        }

        const dataRows = rows.slice(1);
        batch.total = dataRows.length;
        await batch.save();

        if (io) {
          io.to('/crm').emit('import:progress', { batchId, total: batch.total, success: 0, failed: 0, status: 'processing' });
        }

        const tenant = await Tenant.findById(tenantId);
        const welcomeTemplate = tenant?.whatsappWelcomeTemplateName || 'lead_welcome_v1';
        const senderName = tenant?.senderDisplayName || tenant?.name || 'NextLead';

        for (let i = 0; i < dataRows.length; i++) {
          const row = dataRows[i];
          const rowNum = i + 2;

          try {
            const name = mapping.name !== undefined ? String(row[mapping.name] || '').trim() : '';
            const rawPhone = mapping.phone !== undefined ? String(row[mapping.phone] || '').trim() : '';
            const email = mapping.email !== undefined ? String(row[mapping.email] || '').trim() : '';
            const propertyVal = mapping.property !== undefined ? String(row[mapping.property] || '').trim() : '';
            const source = mapping.source !== undefined ? String(row[mapping.source] || '').trim() : 'Bulk Import';
            const budgetStr = mapping.budget !== undefined ? String(row[mapping.budget] || '').trim() : '';
            const notes = mapping.notes !== undefined ? String(row[mapping.notes] || '').trim() : '';

            if (!rawPhone) {
              batch.rowErrors.push({ row: rowNum, error: 'Phone number is missing' });
              batch.failed += 1;
              await batch.save();
              continue;
            }

            let phoneDigits = rawPhone.replace(/\D/g, '');
            if (phoneDigits.startsWith('0')) phoneDigits = phoneDigits.substring(1);
            if (phoneDigits.length === 10) {
              phoneDigits = '91' + phoneDigits;
            }

            if (phoneDigits.length !== 12 || !phoneDigits.startsWith('91')) {
              batch.rowErrors.push({ row: rowNum, error: `Invalid Indian phone number format: ${rawPhone}` });
              batch.failed += 1;
              await batch.save();
              continue;
            }

            const normalizedPhone = phoneDigits;
            let resolvedPropertyId: string | null = null;
            let propertyTitle = 'our properties';

            if (propertyVal) {
              let prop = null;
              if (mongoose.Types.ObjectId.isValid(propertyVal)) {
                prop = await Property.findOne({ tenantId, _id: propertyVal });
              }
              if (!prop) {
                const allProps = await Property.find({ tenantId });
                const fuse = new Fuse(allProps, { keys: ['title'], threshold: 0.4 });
                const matches = fuse.search(propertyVal);
                if (matches.length > 0) {
                  prop = matches[0].item;
                }
              }

              if (prop) {
                resolvedPropertyId = prop._id.toString();
                propertyTitle = prop.title;
              }
            }

            let budget = 0;
            if (budgetStr) {
              const cleanedBudget = budgetStr.replace(/[^\d.]/g, '');
              budget = Number(cleanedBudget) || 0;
              if (budget > 0 && budget < 1000) {
                const lowerBudgetStr = budgetStr.toLowerCase();
                if (lowerBudgetStr.includes('cr') || lowerBudgetStr.includes('crore')) {
                  budget *= 10000000;
                } else if (lowerBudgetStr.includes('lakh') || lowerBudgetStr.includes('l')) {
                  budget *= 100000;
                }
              }
            }

            let lead = await Lead.findOne({ tenantId, mobile: normalizedPhone });

            if (lead) {
              if (dedupeMode === 'skip') {
                batch.rowErrors.push({ row: rowNum, error: `Skipped: Duplicate mobile number ${normalizedPhone}` });
                batch.failed += 1;
                await batch.save();
                continue;
              } else if (dedupeMode === 'update') {
                lead.name = name || lead.name;
                lead.email = email || lead.email;
                if (budget > 0) lead.budget = budget;
                if (source) lead.source = source;

                lead.timeline.push({
                  event: 'Lead Details Updated',
                  timestamp: new Date(),
                  actor: 'System',
                  details: `Details updated via bulk import. Batch ID: ${batchId}. Mapped notes: ${notes || 'None'}`,
                });
                await lead.save();
                batch.success += 1;
              } else {
                lead.timeline.push({
                  event: 'Duplicate Import Warning',
                  timestamp: new Date(),
                  actor: 'System',
                  details: `Duplicate phone import attempted. Batch ID: ${batchId}. Mapped notes: ${notes || 'None'}`,
                });
                lead.score = 'Warm';
                await lead.save();
                batch.success += 1;
              }
            } else {
              // Check if limit is reached!
              const currentCount = await Lead.countDocuments({ tenantId });
              if (tenant && currentCount >= tenant.maxLeads) {
                batch.rowErrors.push({ 
                  row: rowNum, 
                  error: `Skipped: Lead limit reached for this workspace (${currentCount}/${tenant.maxLeads}). Please upgrade your plan.` 
                });
                batch.failed += 1;
                await batch.save();
                continue;
              }

              lead = new Lead({
                tenantId,
                name: name || 'Anonymous',
                mobile: normalizedPhone,
                email: email || '',
                source: source || 'Bulk Import',
                budget: budget,
                status: 'New',
                timeline: [
                  {
                    event: 'Lead Created',
                    timestamp: new Date(),
                    actor: 'System',
                    details: `Bulk imported via csv/excel. Batch ID: ${batchId}. Mapped notes: ${notes || 'None'}`,
                  },
                ],
              });

              if (resolvedPropertyId) {
                lead.aiContext = {
                  attempts: 0,
                  proposedPropertyId: resolvedPropertyId,
                  proposedSlots: [],
                  selectedVisitDay: '',
                  selectedVisitPeriod: '',
                };
              }

              await lead.save();
              batch.success += 1;

              if (whatsappQueue) {
                await whatsappQueue.add('send-welcome-template', {
                  leadId: lead._id.toString(),
                  to: lead.mobile,
                  templateName: welcomeTemplate,
                  parameters: [
                    { type: 'text', text: lead.name },
                    { type: 'text', text: propertyTitle },
                    { type: 'text', text: senderName }
                  ]
                });
              }

              if (qualifyQueue) {
                await qualifyQueue.add('qualify', { leadId: lead._id });
              }
            }

            await batch.save();
            if (io) {
              io.to('/crm').emit('import:progress', {
                batchId,
                total: batch.total,
                success: batch.success,
                failed: batch.failed,
                status: 'processing'
              });
              io.to('/crm').emit('lead:new', lead);
            }
          } catch (rowErr: any) {
            batch.rowErrors.push({ row: rowNum, error: rowErr.message });
            batch.failed += 1;
            await batch.save();
          }
        }

        batch.status = 'completed';
        await batch.save();
        if (io) io.to('/crm').emit('import:progress', { batchId, total: batch.total, success: batch.success, failed: batch.failed, status: 'completed' });

      } catch (err: any) {
        batch.status = 'failed';
        batch.rowErrors.push({ row: 0, error: `Fatal processing error: ${err.message}` });
        await batch.save();
        if (io) io.to('/crm').emit('import:progress', { batchId, total: batch.total, success: batch.success, failed: batch.failed, status: 'failed' });
      }
    },
    { connection }
  );

  // 8. PDF Ingestion Worker
  const pdfIngestionWorker = new Worker(
    'pdf-ingestion',
    async (job) => {
      const { documentId, tenantId, propertyId, filePath } = job.data;
      const projectDoc = await ProjectDocument.findOne({ _id: documentId, tenantId });
      if (!projectDoc) return;

      const io = getIO();

      try {
        const fs = require('fs');
        if (!fs.existsSync(filePath)) {
          throw new Error(`PDF file not found at ${filePath}`);
        }

        const pages: string[] = [];
        const options = {
          pagerender: function (pageData: any) {
            return pageData.getTextContent().then((textContent: any) => {
              const pageText = textContent.items.map((item: any) => item.str).join(' ');
              pages[pageData.pageIndex] = pageText;
              return pageText;
            });
          }
        };

        const fileBuffer = fs.readFileSync(filePath);
        const dataUint8 = new Uint8Array(fileBuffer.buffer, fileBuffer.byteOffset, fileBuffer.byteLength);
        let pdf: any = pdfParse;
        if (typeof pdf !== 'function') {
          pdf = (pdfParse as any).default || require('pdf-parse');
        }

        if (typeof pdf === 'function') {
          await pdf(dataUint8, options);
        } else if (pdf && typeof pdf.PDFParse === 'function') {
          const instance = new pdf.PDFParse(dataUint8);
          const result = await instance.getText();
          if (result && result.pages) {
            result.pages.forEach((p: any) => {
              pages[p.num - 1] = p.text;
            });
          }
        } else {
          throw new Error('Unable to resolve pdf-parse as a function or PDFParse class constructor.');
        }

        if (pages.length === 0 || pages.every(p => !p || !p.trim())) {
          throw new Error('No extractable text found in PDF (scanned image). Please run OCR.');
        }

        const splitter = new RecursiveCharacterTextSplitter({
          chunkSize: 600,
          chunkOverlap: 100,
        });

        await DocumentChunk.deleteMany({ tenantId, propertyId, documentId });

        for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
          const pageText = pages[pageIdx];
          if (!pageText || !pageText.trim()) continue;

          const textChunks = await splitter.splitText(pageText);

          for (let chunkIdx = 0; chunkIdx < textChunks.length; chunkIdx++) {
            const chunkText = textChunks[chunkIdx];

            const embedding = await generateQueryEmbedding(chunkText);

            await DocumentChunk.create({
              tenantId,
              propertyId,
              documentId,
              pageNumber: pageIdx + 1,
              chunkIndex: chunkIdx,
              text: chunkText,
              embedding,
            });
          }
        }

        projectDoc.status = 'ready';
        await projectDoc.save();

        if (io) {
          io.to('/crm').emit('document:processed', { documentId, propertyId, status: 'ready' });
        }
      } catch (err: any) {
        console.error('[PDF Ingestion Error]:', err.message);
        projectDoc.status = 'failed';
        projectDoc.errorReason = err.message;
        await projectDoc.save();

        if (io) {
          io.to('/crm').emit('document:processed', { documentId, propertyId, status: 'failed', error: err.message });
        }
      }
    },
    { connection }
  );

  console.log('[Queue] Workers successfully registered and listening!');
};
