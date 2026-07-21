import { WhatsAppProvider, ProviderStatus } from './whatsappProviderInterface';
import {
  sendOpenWAText,
  sendOpenWADocument,
  sendOpenWAImage,
  getOpenWAStatus,
} from './openwaService';

export class OpenWAProvider implements WhatsAppProvider {
  private tenantId: string;

  constructor(tenantId: string) {
    this.tenantId = tenantId;
  }

  async sendText(to: string, message: string): Promise<any> {
    return await sendOpenWAText(this.tenantId, to, message);
  }

  async sendTemplate(to: string, templateName: string, params: any[] = [], lang: string = 'en'): Promise<any> {
    // For OpenWA (WhatsApp Web integration), templates are sent as formatted text messages
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
