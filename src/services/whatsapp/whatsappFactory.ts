import Tenant from '../../models/Tenant';
import OpenWASession from '../../models/OpenWASession';
import { WhatsAppProvider } from './whatsappProviderInterface';
import { MetaWhatsAppProvider } from './metaWhatsAppProvider';
import { OpenWAProvider } from './openwaProvider';

export class WhatsAppFactory {
  static async getProvider(tenantId?: any): Promise<WhatsAppProvider> {
    let tenant = null;
    if (tenantId) {
      tenant = await Tenant.findById(tenantId.toString ? tenantId.toString() : tenantId);
    }
    if (!tenant) {
      tenant = await Tenant.findOne({});
    }

    const resolvedTenantId = tenant ? tenant._id.toString() : (tenantId ? tenantId.toString() : '');
    let providerType = tenant?.whatsappProvider;

    if (!providerType && resolvedTenantId) {
      const openwaSession = await OpenWASession.findOne({ tenantId: resolvedTenantId, status: 'connected' });
      if (openwaSession) {
        providerType = 'openwa';
      }
    }

    if (providerType === 'openwa') {
      return new OpenWAProvider(resolvedTenantId);
    }

    // Default: Meta WhatsApp Cloud API Provider
    const token = tenant?.metaConfig?.accessToken || tenant?.whatsappToken || process.env.WHATSAPP_TOKEN || '';
    const phoneId = tenant?.metaConfig?.phoneNumberId || tenant?.whatsappPhoneId || process.env.WHATSAPP_PHONE_ID || '';

    return new MetaWhatsAppProvider(token, phoneId);
  }
}

export const getWhatsAppProvider = async (tenantId?: any): Promise<WhatsAppProvider> => {
  return await WhatsAppFactory.getProvider(tenantId);
};
