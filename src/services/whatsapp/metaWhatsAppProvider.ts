import axios from 'axios';
import { WhatsAppProvider, ProviderStatus } from './whatsappProviderInterface';
import { formatWhatsAppNumber } from './whatsappService';

export class MetaWhatsAppProvider implements WhatsAppProvider {
  private token: string;
  private phoneId: string;
  private apiUrl: string;

  constructor(token: string, phoneId: string) {
    this.token = token;
    this.phoneId = phoneId;
    this.apiUrl = `https://graph.facebook.com/v18.0/${phoneId}/messages`;
  }

  async sendText(to: string, message: string): Promise<any> {
    const formattedTo = formatWhatsAppNumber(to);
    if (!this.token || !this.phoneId || this.token.startsWith('mock')) {
      console.warn(`[MetaProvider] Mock mode sendText to ${formattedTo}: "${message}"`);
      return { success: true, mock: true };
    }

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: formattedTo,
      type: 'text',
      text: { preview_url: false, body: message },
    };

    const response = await axios.post(this.apiUrl, payload, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
    });
    return response.data;
  }

  async sendTemplate(to: string, templateName: string, params: any[] = [], lang: string = 'en'): Promise<any> {
    const formattedTo = formatWhatsAppNumber(to);
    if (!this.token || !this.phoneId || this.token.startsWith('mock')) {
      console.warn(`[MetaProvider] Mock mode sendTemplate "${templateName}" to ${formattedTo}`);
      return { success: true, mock: true };
    }

    const formattedComponents: any[] = [];
    const headerMedia = params.find(p => p.type === 'image' || p.type === 'document');
    if (headerMedia) {
      formattedComponents.push({
        type: 'header',
        parameters: [
          headerMedia.type === 'image'
            ? { type: 'image', image: { link: headerMedia.image?.link } }
            : { type: 'document', document: { link: headerMedia.document?.link, filename: headerMedia.document?.filename } },
        ],
      });
    }

    const bodyParams = params.filter(p => p.type === 'text');
    if (bodyParams.length > 0) {
      formattedComponents.push({
        type: 'body',
        parameters: bodyParams.map(p => ({ type: 'text', text: p.text })),
      });
    }

    const payload: any = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: formattedTo,
      type: 'template',
      template: {
        name: templateName,
        language: { code: lang },
      },
    };
    if (formattedComponents.length > 0) {
      payload.template.components = formattedComponents;
    }

    const response = await axios.post(this.apiUrl, payload, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
    });
    return response.data;
  }

  async sendDocument(to: string, documentUrl: string, filename: string, caption?: string): Promise<any> {
    const formattedTo = formatWhatsAppNumber(to);
    if (!this.token || !this.phoneId || this.token.startsWith('mock')) {
      console.warn(`[MetaProvider] Mock mode sendDocument "${filename}" to ${formattedTo}`);
      return { success: true, mock: true };
    }

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: formattedTo,
      type: 'document',
      document: {
        link: documentUrl,
        filename,
        ...(caption ? { caption } : {}),
      },
    };

    const response = await axios.post(this.apiUrl, payload, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
    });
    return response.data;
  }

  async sendImage(to: string, imageUrl: string, caption?: string): Promise<any> {
    const formattedTo = formatWhatsAppNumber(to);
    if (!this.token || !this.phoneId || this.token.startsWith('mock')) {
      console.warn(`[MetaProvider] Mock mode sendImage to ${formattedTo}`);
      return { success: true, mock: true };
    }

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: formattedTo,
      type: 'image',
      image: {
        link: imageUrl,
        ...(caption ? { caption } : {}),
      },
    };

    const response = await axios.post(this.apiUrl, payload, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
    });
    return response.data;
  }

  async getStatus(): Promise<ProviderStatus> {
    const isConfigured = Boolean(this.token && this.phoneId && !this.token.startsWith('mock'));
    return {
      isConnected: isConfigured,
      provider: 'meta',
      details: {
        phoneId: this.phoneId,
        hasToken: Boolean(this.token),
      },
    };
  }
}
