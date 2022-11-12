import { Chain, Connector, ConnectorData, normalizeChainId, UserRejectedRequestError } from "@wagmi/core";
import QRCodeModal from "@walletconnect/qrcode-modal";
import {
  ADAPTER_CATEGORY,
  ADAPTER_EVENTS,
  ADAPTER_STATUS,
  BaseAdapterConfig,
  CHAIN_NAMESPACES,
  CONNECTED_EVENT_DATA,
  CustomChainConfig,
  getChainConfig,
  IAdapter,
  SafeEventEmitterProvider,
  storageAvailable,
  WALLET_ADAPTER_TYPE,
  WALLET_ADAPTERS,
} from "@web3auth/base";
import { Web3AuthCore } from "@web3auth/core";
import { MetamaskAdapter } from "@web3auth/metamask-adapter";
import { OpenloginAdapter } from "@web3auth/openlogin-adapter";
import { TorusWalletAdapter } from "@web3auth/torus-evm-adapter";
import LoginModal, { getAdapterSocialLogins, LOGIN_MODAL_EVENTS, OPENLOGIN_PROVIDERS } from "@web3auth/ui";
import { WalletConnectV1Adapter } from "@web3auth/wallet-connect-v1-adapter";
import { AdaptersModalConfig, defaultEvmDappModalConfig, ModalConfig } from "@web3auth/web3auth";
import { ethers, Signer } from "ethers";
import { getAddress } from "ethers/lib/utils";
import EventEmitter from "events";
import { Provider } from "react";
import { ConnectorEvents, defaultChains } from "wagmi";

import { Options } from "./interfaces";

const IS_SERVER = typeof window === "undefined";
const ADAPTER_CACHE_KEY = "Web3Auth-cachedAdapter";

export class Web3AuthConnectorLocal extends Connector {
  ready = !IS_SERVER;

  readonly id = "web3Auth";

  readonly name = "web3Auth";

  provider: SafeEventEmitterProvider;

  web3AuthInstance?: Web3AuthCore;

  isModalOpen = false;

  web3AuthOptions: Options;

  private loginModal: LoginModal;

  private socialLoginAdapter: OpenloginAdapter;

  private torusWalletAdapter: TorusWalletAdapter;

  private metamaskAdapter: MetamaskAdapter;

  private walletConnectV1Adapter: WalletConnectV1Adapter;

  private adapters: Record<string, IAdapter<unknown>> = {};

  private modalConfig: AdaptersModalConfig = defaultEvmDappModalConfig;

  private storage: "sessionStorage" | "localStorage" = "localStorage";

  constructor(config: { chains?: Chain[]; options: Options }) {
    super(config);
    this.web3AuthOptions = config.options;
    const chainId = config.options.chainId ? parseInt(config.options.chainId, 16) : 1;
    const chainConfig = this.chains.filter((x) => x.id === chainId);

    const defaultChainConfig = getChainConfig(CHAIN_NAMESPACES.EIP155, config.options.chainId || "0x1");
    let finalChainConfig: CustomChainConfig = {
      chainNamespace: CHAIN_NAMESPACES.EIP155,
      ...defaultChainConfig,
    };
    if (chainConfig.length > 0) {
      finalChainConfig = {
        ...finalChainConfig,
        chainNamespace: CHAIN_NAMESPACES.EIP155,
        chainId: config.options.chainId || "0x1",
        rpcTarget: chainConfig[0].rpcUrls.default,
        displayName: chainConfig[0].name,
        tickerName: chainConfig[0].nativeCurrency?.name,
        ticker: chainConfig[0].nativeCurrency?.symbol,
        blockExplorer: chainConfig[0]?.blockExplorers.default?.url,
      };
    }

    this.web3AuthInstance = new Web3AuthCore({
      clientId: config.options.clientId,
      chainConfig: {
        chainNamespace: CHAIN_NAMESPACES.EIP155,
        chainId: "0x1",
        rpcTarget: "https://rpc.ankr.com/eth", // This is the public RPC we have added, please pass on your own endpoint while creating an app
      },
    });

    this.socialLoginAdapter = new OpenloginAdapter({
      adapterSettings: {
        ...config.options,
      },
      chainConfig: {
        chainId: "0x1",
        chainNamespace: CHAIN_NAMESPACES.EIP155,
        rpcTarget: "https://rpc.ankr.com/eth",
        displayName: "mainnet",
        blockExplorer: "https://etherscan.io/",
        ticker: "ETH",
        tickerName: "Ethereum",
      },
    });

    this.torusWalletAdapter = new TorusWalletAdapter({
      adapterSettings: {
        buttonPosition: "bottom-left",
      },
      loginSettings: {
        verifier: "google",
      },
      initParams: {
        buildEnv: "testing",
      },
      chainConfig: {
        chainNamespace: CHAIN_NAMESPACES.EIP155,
        chainId: "0x1",
        rpcTarget: "https://rpc.ankr.com/eth", // This is the mainnet RPC we have added, please pass on your own endpoint while creating an app
        displayName: "Ethereum Mainnet",
        blockExplorer: "https://etherscan.io/",
        ticker: "ETH",
        tickerName: "Ethereum",
      },
    });

    this.metamaskAdapter = new MetamaskAdapter({
      clientId: config.options.clientId,
    });

    this.walletConnectV1Adapter = new WalletConnectV1Adapter({
      adapterSettings: {
        bridge: "https://bridge.walletconnect.org",
        qrcodeModal: QRCodeModal,
      },
      clientId: config.options.clientId,
    });

    this.web3AuthInstance.configureAdapter(this.socialLoginAdapter);
    this.web3AuthInstance.configureAdapter(this.torusWalletAdapter);
    this.web3AuthInstance.configureAdapter(this.metamaskAdapter);
    this.web3AuthInstance.configureAdapter(this.walletConnectV1Adapter);
    this.adapters[this.socialLoginAdapter.name] = this.socialLoginAdapter;
    this.adapters[this.torusWalletAdapter.name] = this.torusWalletAdapter;
    this.adapters[this.metamaskAdapter.name] = this.metamaskAdapter;
    this.adapters[this.walletConnectV1Adapter.name] = this.walletConnectV1Adapter;

    this.loginModal = new LoginModal({
      theme: this.options.uiConfig?.theme,
      appLogo: this.options.uiConfig?.appLogo || "",
      version: "",
      adapterListener: this.web3AuthInstance,
      displayErrorsOnModal: this.options.displayErrorsOnModal,
    });

    // this.loginModal.initExternalWalletContainer();
    this.subscribeToLoginModalEvents();
  }

  async connect(): Promise<Required<ConnectorData>> {
    this.web3AuthInstance.init();
    const adapterEventsPromise = this.subscribeToAdpaterConnectionEvents();
    await this.init();
    this.loginModal.open();
    const elem = document.getElementById("w3a-container");
    elem.style.zIndex = "10000000000";
    return (await adapterEventsPromise) as Required<ConnectorData>;
  }

  async subscribeToAdpaterConnectionEvents(): Promise<Required<ConnectorData>> {
    return new Promise((resolve, reject) => {
      this.web3AuthInstance.once(ADAPTER_EVENTS.CONNECTED, async () => {
        console.log("Received event connected: ", this.web3AuthInstance.connectedAdapterName);
        console.log("Requesting Signer");
        const signer = await this.getSigner();
        const account = await signer.getAddress();
        const provider = await this.getProvider();

        if (provider.on) {
          provider.on("accountsChanged", this.onAccountsChanged.bind(this));
          provider.on("chainChanged", this.onChainChanged.bind(this));
          provider.on("disconnect", this.onDisconnect.bind(this));
        }

        return resolve({
          account,
          chain: {
            id: 0,
            unsupported: false,
          },
          provider,
        });
      });
      this.web3AuthInstance.once(ADAPTER_EVENTS.ERRORED, (err: unknown) => {
        console.log("error while connecting", err);
        return reject(err);
      });
    });
  }

  async init(): Promise<void> {
    console.log("What is this type: ", typeof this);
    console.log("What is this instance: ", this instanceof Web3AuthConnectorLocal);
    try {
      await this.loginModal.initModal();
      const allAdapters = [...new Set([...Object.keys(this.modalConfig.adapters || {}), ...Object.keys(this.adapters)])];
      const adapterNames = ["torus-evm", "metamask", "openlogin", "wallet-connect-v1"];
      const hasInAppWallets = true;
      // Now, initialize the adapters.
      const initPromises = adapterNames.map(async (adapterName) => {
        if (!adapterName) return;
        try {
          const adapter = this.adapters[adapterName];
          console.log("Adapter Found: ", adapterName);
          console.log("Cached Adapter: ", this.web3AuthInstance.cachedAdapter);

          // only initialize a external adapter here if it is a cached adapter.
          if (this.web3AuthInstance.cachedAdapter !== adapterName && adapter.type === ADAPTER_CATEGORY.EXTERNAL) {
            console.log(adapterName, " Adapter is not External");
            return;
          }
          // in-app wallets or cached wallet (being connected or already connected) are initialized first.
          // if adapter is configured thn only initialize in app or cached adapter.
          // external wallets are initialized on INIT_EXTERNAL_WALLET event.
          this.subscribeToAdapterEvents(adapter);
          if (adapter.status === ADAPTER_STATUS.NOT_READY) {
            await adapter.init({
              autoConnect: this.web3AuthInstance.cachedAdapter === adapterName,
            });
            console.log("Initializing In Wallet: COMPLETED", adapter, adapter.status);
          }

          // note: not adding cachedWallet to modal if it is external wallet.
          // adding it later if no in-app wallets are available.
          if (adapter.type === ADAPTER_CATEGORY.IN_APP) {
            this.loginModal.addSocialLogins(
              WALLET_ADAPTERS.OPENLOGIN,
              getAdapterSocialLogins(WALLET_ADAPTERS.OPENLOGIN, this.socialLoginAdapter, this.options.uiConfig?.loginMethodConfig),
              this.options.uiConfig?.loginMethodsOrder || OPENLOGIN_PROVIDERS
            );
          }
        } catch (error) {
          console.log(error, "error while initializing adapter");
        }
      });

      this.web3AuthInstance.status = ADAPTER_STATUS.READY;
      await Promise.all(initPromises);
      const hasExternalWallets = allAdapters.some((adapterName) => {
        return this.adapters[adapterName]?.type === ADAPTER_CATEGORY.EXTERNAL && this.modalConfig.adapters?.[adapterName].showOnModal;
      });
      console.log("Has External Wallets: ", hasExternalWallets);
      if (hasExternalWallets) {
        this.loginModal.initExternalWalletContainer();
      }
      if (!hasInAppWallets && hasExternalWallets) {
        await this.initExternalWalletAdapters(false, {
          showExternalWalletsOnly: true,
        });
      }
    } catch (error) {
      console.log("error while connecting", error);
      throw new UserRejectedRequestError("Something went wrong");
    }
  }

  async getAccount(): Promise<string> {
    const provider = new ethers.providers.Web3Provider(await this.getProvider());
    const signer = provider.getSigner();
    const account = await signer.getAddress();
    return account;
  }

  async getProvider() {
    if (this.provider) {
      return this.provider;
    }
    this.provider = this.web3AuthInstance.provider;
    return this.provider;
  }

  async getSigner(): Promise<Signer> {
    console.log("Getting Signer");
    const provider = new ethers.providers.Web3Provider(await this.getProvider());
    const signer = provider.getSigner();
    return signer;
  }

  async isAuthorized() {
    try {
      const account = await this.getAccount();
      return !!(account && this.provider);
    } catch {
      return false;
    }
  }

  async getChainId(): Promise<number> {
    try {
      const networkOptions = this.socialLoginAdapter.chainConfigProxy;
      if (typeof networkOptions === "object") {
        const chainID = networkOptions.chainId;
        if (chainID) {
          return normalizeChainId(chainID);
        }
      }
      throw new Error("Chain ID is not defined");
    } catch (error) {
      console.log("error", error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    await this.web3AuthInstance.logout();
    this.provider = null;
  }

  protected onAccountsChanged(accounts: string[]): void {
    if (accounts.length === 0) this.emit("disconnect");
    else this.emit("change", { account: getAddress(accounts[0]) });
  }

  protected onChainChanged(chainId: string | number): void {
    const id = normalizeChainId(chainId);
    const unsupported = this.isChainUnsupported(id);
    this.emit("change", { chain: { id, unsupported } });
  }

  protected onDisconnect(): void {
    this.emit("disconnect");
  }

  private subscribeToLoginModalEvents(): void {
    this.loginModal.on(LOGIN_MODAL_EVENTS.LOGIN, async (params: { adapter: WALLET_ADAPTER_TYPE; loginParams: unknown }) => {
      try {
        console.log("Wallet Adapters: ", +params.adapter);
        await this.web3AuthInstance.connectTo<unknown>(params.adapter, params.loginParams);
      } catch (error) {
        console.log(`Error while connecting to adapter: ${params.adapter}`, error);
      }
    });

    this.loginModal.on(LOGIN_MODAL_EVENTS.INIT_EXTERNAL_WALLETS, async (params: { externalWalletsInitialized: boolean }) => {
      await this.initExternalWalletAdapters(params.externalWalletsInitialized);
    });

    this.loginModal.on(LOGIN_MODAL_EVENTS.DISCONNECT, async () => {
      try {
        await this.disconnect();
      } catch (error) {
        console.log(`Error while disconnecting`, error);
      }
    });
  }

  private async initExternalWalletAdapters(externalWalletsInitialized: boolean, options?: { showExternalWalletsOnly: boolean }): Promise<void> {
    if (externalWalletsInitialized) return;
    const adaptersConfig: Record<string, BaseAdapterConfig> = {};
    const adaptersData: Record<string, unknown> = {};
    const adapterPromises = Object.keys(this.adapters).map(async (adapterName) => {
      try {
        const adapter = this.adapters[adapterName];
        if (adapter?.type === ADAPTER_CATEGORY.EXTERNAL) {
          console.log("init external wallet", adapterName);
          this.subscribeToAdapterEvents(adapter);
          // we are not initializing cached adapter here as it is already being initialized in initModal before.
          if (this.web3AuthInstance.cachedAdapter === adapterName) {
            return;
          }
          if (adapter.status === ADAPTER_STATUS.NOT_READY) {
            console.log(`Adapter not Ready: ${adapterName}`);
            return await Promise.race([
              adapter
                .init({
                  autoConnect: this.web3AuthInstance.cachedAdapter === adapterName,
                })
                .then(() => {
                  adaptersConfig[adapterName] = (defaultEvmDappModalConfig.adapters as Record<WALLET_ADAPTER_TYPE, ModalConfig>)[adapterName];
                  adaptersData[adapterName] = adapter.adapterData || {};
                  console.log("Adapter Init: ", adapterName);
                  return adapterName;
                }),
              new Promise((resolve) => {
                setTimeout(() => {
                  return resolve(null);
                }, 5000);
              }),
            ]);
          }
          console.log(`Adapter Ready: ${adapterName}`);
          return adapterName;
        }
      } catch (error) {
        console.log(error, "error while initializing adapter");
      }
    });

    const adapterInitResults = await Promise.all(adapterPromises);
    console.log("Adapter Init Results: ", adapterInitResults);
    const finalAdaptersConfig: Record<WALLET_ADAPTER_TYPE, BaseAdapterConfig> = {};
    adapterInitResults.forEach((result: string | undefined) => {
      if (result) {
        finalAdaptersConfig[result] = adaptersConfig[result];
      }
    });
    this.loginModal.addWalletLogins(finalAdaptersConfig, {
      showExternalWalletsOnly: !!options?.showExternalWalletsOnly,
    });
  }

  private subscribeToAdapterEvents(walletAdapter: IAdapter<unknown>): void {
    console.log("Running adapter events");
    walletAdapter.on(ADAPTER_EVENTS.CONNECTED, (data: CONNECTED_EVENT_DATA) => {
      const status = ADAPTER_STATUS.CONNECTED;
      this.web3AuthInstance.connectedAdapterName = data.adapter;
      this.cacheWallet(data.adapter);
      console.log("connected", status, this.web3AuthInstance.connectedAdapterName);
      this.web3AuthInstance.emit(ADAPTER_EVENTS.CONNECTED, {
        ...data,
      } as CONNECTED_EVENT_DATA);
    });

    walletAdapter.on(ADAPTER_EVENTS.DISCONNECTED, async (data) => {
      // get back to ready state for rehydrating.
      const status = ADAPTER_STATUS.READY;
      if (storageAvailable(this.storage)) {
        const cachedAdapter = window[this.storage].getItem(ADAPTER_CACHE_KEY);
        if (this.web3AuthInstance.connectedAdapterName === cachedAdapter) {
          this.web3AuthInstance.clearCache();
        }
      }

      console.log("disconnected", status, this.web3AuthInstance.connectedAdapterName);
      this.web3AuthInstance.connectedAdapterName = null;
      this.web3AuthInstance.emit(ADAPTER_EVENTS.DISCONNECTED, data);
    });
    walletAdapter.on(ADAPTER_EVENTS.CONNECTING, (data) => {
      const status = ADAPTER_STATUS.CONNECTING;
      this.web3AuthInstance.emit(ADAPTER_EVENTS.CONNECTING, data);
      console.log("connecting", status, this.web3AuthInstance.connectedAdapterName);
    });
    walletAdapter.on(ADAPTER_EVENTS.ERRORED, (data) => {
      const status = ADAPTER_STATUS.ERRORED;
      this.web3AuthInstance.clearCache();
      this.web3AuthInstance.emit(ADAPTER_EVENTS.ERRORED, data);
      console.log("errored", status, this.web3AuthInstance.connectedAdapterName);
    });

    walletAdapter.on(ADAPTER_EVENTS.ADAPTER_DATA_UPDATED, (data) => {
      console.log("adapter data updated", data);
      this.web3AuthInstance.emit(ADAPTER_EVENTS.ADAPTER_DATA_UPDATED, data);
    });
  }

  private cacheWallet(walletName: string) {
    if (!storageAvailable(this.storage)) return;
    window[this.storage].setItem(ADAPTER_CACHE_KEY, walletName);
    this.web3AuthInstance.cachedAdapter = walletName;
  }
}
