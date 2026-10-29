export interface MediaAsset {
  data: Buffer;
  mimeType: string;
  filename: string;
}

/** Result of one send that Meta's API accepted. */
export interface SendOutcome {
  /** WhatsApp's own message id (wamid) when Meta returned one. */
  wamid: string | null;
}

/** The outbound and inbound WhatsApp operations the bot depends on. */
export interface Messenger {
  downloadMedia(mediaId: string): Promise<MediaAsset>;
  sendText(recipient: string, body: string): Promise<SendOutcome>;
  sendSticker(recipient: string, stickerWebp: Buffer): Promise<SendOutcome>;
}
