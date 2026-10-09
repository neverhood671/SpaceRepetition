/**
 * Ambient TypeScript declarations for Chrome Extension Manifest V3 APIs
 */

declare namespace chrome {
  namespace storage {
    interface StorageArea {
      get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, any>>;
      set(items: Record<string, unknown>): Promise<void>;
    }
    const local: StorageArea;
  }

  namespace runtime {
    interface LastError {
      message?: string;
    }
    const lastError: LastError | undefined;

    interface MessageSender {
      tab?: { id?: number; url?: string; title?: string };
      id?: string;
    }

    const onInstalled: {
      addListener(callback: (details: { reason: string }) => void): void;
    };

    const onMessage: {
      addListener(
        callback: (
          message: any,
          sender: MessageSender,
          sendResponse: (response?: any) => void
        ) => boolean | void
      ): void;
    };

    function sendMessage<M = any, R = any>(
      message: M,
      responseCallback?: (response: R) => void
    ): void;
  }

  namespace contextMenus {
    interface OnClickData {
      menuItemId: string | number;
      selectionText?: string;
    }

    function create(createProperties: {
      id: string;
      title: string;
      contexts: string[];
    }): void;

    const onClicked: {
      addListener(
        callback: (info: OnClickData, tab?: { id?: number }) => void
      ): void;
    };
  }

  namespace tabs {
    function sendMessage(
      tabId: number,
      message: any,
      responseCallback?: (response: any) => void
    ): void;
  }
}

interface Window {
  __svenskaSpacedInjected?: boolean;
}
