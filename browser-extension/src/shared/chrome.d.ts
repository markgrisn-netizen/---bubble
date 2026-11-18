declare namespace chrome {
  namespace runtime {
    interface MessageSender {
      tab?: chrome.tabs.Tab;
      id?: string;
    }
    const onInstalled: {
      addListener(callback: () => void): void;
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
    function sendMessage<T = any>(message: any): Promise<T>;
  }

  namespace tabs {
    interface Tab {
      id?: number;
      url?: string;
      title?: string;
      windowId: number;
    }
    function query(queryInfo: { active?: boolean; currentWindow?: boolean }): Promise<Tab[]>;
    function sendMessage<T = any>(tabId: number, message: any): Promise<T>;
    function captureVisibleTab(
      windowId?: number,
      options?: { format?: 'png' | 'jpeg'; quality?: number }
    ): Promise<string>;
  }

  namespace scripting {
    function executeScript<T = any>(injection: {
      target: { tabId: number };
      files?: string[];
      func?: (...args: any[]) => T;
      args?: any[];
    }): Promise<Array<{ result: T }>>;
  }

  namespace storage {
    interface StorageArea {
      get(keys?: string | string[] | Record<string, any> | null): Promise<Record<string, any>>;
      set(items: Record<string, any>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    }
    const local: StorageArea;
  }

  namespace contextMenus {
    interface CreateProperties {
      id: string;
      title: string;
      contexts: string[];
    }
    function removeAll(callback?: () => void): void;
    function create(createProperties: CreateProperties): void;
    const onClicked: {
      addListener(callback: (info: { menuItemId: string | number }, tab?: chrome.tabs.Tab) => void): void;
    };
  }
}
