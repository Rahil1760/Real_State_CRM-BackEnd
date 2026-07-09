import dotenv from 'dotenv';
import path from 'path';
import { faqVectorIndex } from '../models/FaqCache';
import { generateQueryEmbedding } from '../services/ai/aiTools';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const seedFAQs = [
  {
    question: 'What is the exact price of the property?',
    answer: 'The starting price is ₹1.5 Cr for a 2BHK.',
    category: 'pricing',
    isGuardedFact: true,
  },
  {
    question: 'What amenities are available?',
    answer: 'We offer a swimming pool, clubhouse, gym, and 24/7 security.',
    category: 'amenities',
    isGuardedFact: false,
  },
  {
    question: 'When is the possession date?',
    answer: 'The possession date is set for December 2027.',
    category: 'project_facts',
    isGuardedFact: true,
  },
  {
    question: 'What is the RERA number?',
    answer: 'Our RERA registration number is PRM/KA/RERA/1251/446/PR/123456.',
    category: 'legal',
    isGuardedFact: true,
  }
] as const;

async function runSeeder() {
  const args = process.argv.slice(2);
  let tenantId = '';
  let projectId = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tenantId' && args[i + 1]) tenantId = args[i + 1];
    if (args[i] === '--projectId' && args[i + 1]) projectId = args[i + 1];
  }

  if (!tenantId || !projectId) {
    console.error('Usage: ts-node seedFaqCache.ts --tenantId <ID> --projectId <ID>');
    process.exit(1);
  }

  try {
    let count = 0;
    for (const faq of seedFAQs) {
      console.log(`Generating embedding for: "${faq.question}"`);
      const embedding = await generateQueryEmbedding(
        `${faq.question}\n${faq.answer}`
      );

      const id = `${tenantId}-${projectId}-${count}`;

      await faqVectorIndex.upsert({
        id: id,
        vector: embedding,
        metadata: {
          tenantId,
          projectId,
          question: faq.question,
          answer: faq.answer,
          category: faq.category,
          isGuardedFact: faq.isGuardedFact,
        }
      });
      count++;
    }

    console.log(`Successfully seeded ${count} FAQs to Upstash Vector.`);
  } catch (error) {
    console.error('Error during seeding:', error);
  }
}

runSeeder();
