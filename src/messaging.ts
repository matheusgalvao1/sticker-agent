export interface MediaAsset {
  data: Buffer;
  mimeType: string;
  filename: string;
}

/** The outbound and inbound WhatsApp operations the bot depends on. */
export interface Messenger {
  downloadMedia(mediaId: string): Promise<MediaAsset>;
  sendText(recipient: string, body: string): Promise<void>;
  sendSticker(recipient: string, stickerWebp: Buffer): Promise<void>;
}
