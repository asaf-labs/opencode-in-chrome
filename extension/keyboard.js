import { keyboardKey, keyboardText, parseFocusToken } from './keyboard-keys.js';
import { pageResult, runPageTool } from './page-call.js';

export class TrustedKeyboard {
  constructor(chrome, browser) {
    this.chrome = chrome;
    this.browser = browser;
  }

  async guard(command, tabID, focus, consume = false) {
    this.browser.assert(command);
    if (this.browser.owner(tabID)?.[0] !== command.sessionID)
      throw new Error('Keyboard input requires a session-owned tab.');
    const tab = await this.chrome.tabs.get(tabID);
    const [active, window] = await Promise.all([
      this.chrome.tabs.query({ active: true, lastFocusedWindow: true }),
      this.chrome.windows.get(tab.windowId),
    ]);
    this.browser.assert(command);
    if (
      tab.status !== 'complete' ||
      !/^https?:\/\//.test(tab.url || '') ||
      !window.focused ||
      active[0]?.id !== tabID
    )
      throw new Error(
        'Focus this owned tab with focus_tab and take a fresh read_page before keyboard input.',
      );
    const documentID = this.browser.frameDocuments.get(tabID)?.get(focus.frameID);
    if (!documentID)
      throw new Error('Keyboard frame is not in the latest snapshot. Call read_page again.');
    const results = await this.chrome.scripting.executeScript({
      target: { tabId: tabID, frameIds: [focus.frameID] },
      func: runPageTool,
      args: [
        'keyboard_guard',
        {
          documentID,
          focusToken: focus.token,
          commandID: command.id,
          consume,
          requireEditable: command.tool === 'insert_text',
        },
      ],
    });
    this.browser.assert(command);
    if (pageResult(results[0]?.result)?.valid !== true)
      throw new Error('Keyboard focus could not be validated. Call read_page again.');
  }

  async run(command, tab) {
    const focus = parseFocusToken(command.args.focusToken);
    const plan = command.tool === 'press_key' ? keyboardKey(command.args.key) : null;
    if (!plan) keyboardText(command.args.text);
    let lease,
      error,
      attempted = false,
      completed = false,
      mask = 0;
    const pressed = [];
    const send = async (key, type) =>
      this.chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', {
        type,
        key: key.key,
        code: key.code,
        windowsVirtualKeyCode: key.windowsVirtualKeyCode,
        modifiers: mask,
        ...(type === 'keyDown' && key.text
          ? { text: key.text, unmodifiedText: key.unmodifiedText }
          : {}),
      });
    try {
      await this.guard(command, tab.id, focus);
      lease = await this.browser.debuggers.acquire(command, tab.id);
      await this.guard(command, tab.id, focus, true);
      if (plan) {
        for (const key of [...plan.modifiers, plan.key]) {
          await this.guard(command, tab.id, focus);
          if (!this.browser.debuggers.valid(lease)) throw new Error('Keyboard debugger detached.');
          mask |= key.bit || 0;
          pressed.push(key);
          attempted = true;
          await send(key, 'keyDown');
        }
      } else {
        if (!this.browser.debuggers.valid(lease)) throw new Error('Keyboard debugger detached.');
        attempted = true;
        await this.chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.insertText', {
          text: command.args.text,
        });
      }
      this.browser.assert(command);
      completed = true;
    } catch (failure) {
      error = failure;
    } finally {
      for (const key of pressed.reverse()) {
        mask &= ~(key.bit || 0);
        if (!this.browser.debuggers.valid(lease)) {
          error ||= new Error('Keyboard debugger detached before key-up cleanup.');
          completed = false;
          continue;
        }
        try {
          await send(key, 'keyUp');
        } catch (failure) {
          error ||= failure;
          completed = false;
        }
      }
      await this.browser.debuggers.release(lease, { debounce: completed });
    }
    if (error)
      throw new Error(
        `${error.message}${attempted ? ' Keyboard input may already have affected the page; inspect it before retrying. No retry was performed.' : ''}`,
      );
    return {
      tabID: tab.id,
      frameID: focus.frameID,
      dispatched: true,
      applicationAccepted: null,
      focusTokenConsumed: true,
    };
  }
}
