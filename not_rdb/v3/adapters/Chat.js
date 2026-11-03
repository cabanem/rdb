/**
 * @file adapters/Chat.gs
 * Google Chat webhook notifier and the review card.
 */

/**
 * Google Chat webhook notifier. Always sends a JSON object, never a bare string.
 * @class
 */
class ChatNotifier {
  /** @param {string} webhookUrl Incoming webhook url; falsy disables sending. */
  constructor(webhookUrl) { this.url = webhookUrl; }
  /**
   * POST a Chat message object (e.g. {text} or {cardsV2}).
   * @param {Object} message
   * @return {void}
   */
  send(message) {
    if (!this.url) { Logger.log('chat_webhook_url not set'); return; }
    const res = UrlFetchApp.fetch(this.url, {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify(message), muteHttpExceptions: true
    });
    if (res.getResponseCode() >= 400) Logger.log('Chat error: ' + res.getContentText());
  }
  /**
   * Convenience for a plain-text Chat message.
   * @param {string} s
   * @return {void}
   */
  text(s) { this.send({ text: s }); }
}

/**
 * Send a cardsV2 notification with a button that opens the review sheet.
 * @param {ChatNotifier} notifier
 * @param {string} sheetUrl
 * @param {string} fileName
 * @private
 */
function notifyReview_(notifier, sheetUrl, fileName) {
  notifier.send({
    cardsV2: [{
      cardId: 'contractReview',
      card: {
        header: { title: 'Contract staged for review', subtitle: fileName },
        sections: [{
          widgets: [
            { textParagraph: { text: 'Open the sheet, correct the <b>Approved</b> column (highlighted cells need a choice), then check the <b>Approved</b> box.' } },
            { buttonList: { buttons: [{ text: 'Open review sheet', onClick: { openLink: { url: sheetUrl } } }] } }
          ]
        }]
      }
    }]
  });
}
