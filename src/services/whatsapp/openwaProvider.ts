import { WhatsAppProvider, ProviderStatus } from './whatsappProviderInterface';
import {
  sendOpenWAText,
  sendOpenWADocument,
  sendOpenWAImage,
  getOpenWAStatus,
} from './openwaService';
import Tenant from '../../models/Tenant';
import Property from '../../models/Property';

export class OpenWAProvider implements WhatsAppProvider {
  private tenantId: string;

  constructor(tenantId: any) {
    this.tenantId = tenantId && typeof tenantId === 'object' && '_id' in tenantId 
      ? (tenantId as any)._id.toString() 
      : tenantId?.toString();
  }

  async sendText(to: string, message: string): Promise<any> {
    return await sendOpenWAText(this.tenantId, to, message);
  }

  async sendTemplate(to: string, templateName: string, params: any[] = [], lang: string = 'en'): Promise<any> {
    const isWelcome = templateName.toLowerCase().includes('welcome') || templateName === 'ashiyana' || templateName === 'hello_world';
    if (isWelcome) {
      let companyName = 'our real estate team';
      let locationsList = 'prime locations';
      let leadName = 'there';

      try {
        if (this.tenantId) {
          const tenant = await Tenant.findById(this.tenantId);
          if (tenant) {
            companyName = tenant.senderDisplayName || tenant.name || companyName;
          }
          const properties = await Property.find({ tenantId: this.tenantId });
          const uniqueLocations = properties
            .map(p => p.location)
            .filter((loc, idx, arr) => loc && loc.trim() !== '' && arr.indexOf(loc) === idx);
          if (uniqueLocations.length > 0) {
            locationsList = uniqueLocations.join(', ');
          }
        }
      } catch (err) {
        console.error('[OpenWA Provider] Error fetching tenant/properties for welcome template:', err);
      }

      if (params && params.length > 0) {
        const textParam = params.find(p => p.type === 'text' && p.text);
        if (textParam && textParam.text) {
          leadName = textParam.text.split(' ')[0];
        }
      }

      const openwaWelcomeMessage = `Hi ${leadName}, thank you for reaching out to ${companyName}! 🏡\n\nWe have premium ongoing projects in: ${locationsList}.\n\nPlease let me know how may i assist you ?`;

      return await sendOpenWAText(this.tenantId, to, openwaWelcomeMessage);
    }

    // Generic non-welcome template fallback
    let formattedText = `*[${templateName.toUpperCase()}]*\n`;
    if (params && params.length > 0) {
      const textVars = params.filter(p => p.type === 'text').map(p => p.text).join('\n');
      if (textVars) {
        formattedText += textVars;
      }
    }
    return await sendOpenWAText(this.tenantId, to, formattedText.trim());
  }

  async sendDocument(to: string, documentUrl: string, filename: string, caption?: string): Promise<any> {
    return await sendOpenWADocument(this.tenantId, to, documentUrl, filename, caption);
  }

  async sendImage(to: string, imageUrl: string, caption?: string): Promise<any> {
    return await sendOpenWAImage(this.tenantId, to, imageUrl, caption);
  }

  async getStatus(): Promise<ProviderStatus> {
    const statusData = await getOpenWAStatus(this.tenantId);
    return {
      isConnected: statusData.isConnected,
      provider: 'openwa',
      details: statusData,
    };
  }
}
