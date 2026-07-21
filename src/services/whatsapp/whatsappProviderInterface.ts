export interface ProviderStatus {
  isConnected: boolean;
  provider: 'meta' | 'openwa';
  details?: any;
}

export interface WhatsAppProvider {
  sendText(to: string, message: string): Promise<any>;
  sendTemplate(to: string, templateName: string, params?: any[], lang?: string): Promise<any>;
  sendDocument(to: string, documentUrl: string, filename: string, caption?: string): Promise<any>;
  sendImage(to: string, imageUrl: string, caption?: string): Promise<any>;
  getStatus(): Promise<ProviderStatus>;
}
