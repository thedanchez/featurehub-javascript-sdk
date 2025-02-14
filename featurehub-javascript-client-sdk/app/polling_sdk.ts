// prevents circular deps
import { FeatureEnvironmentCollection, FeatureState, SSEResultState } from './models';
import { EdgeService } from './edge_service';
import { FeatureHubConfig, fhLog } from './feature_hub_config';
import { InternalFeatureRepository } from './internal_feature_repository';
import { sha256 } from 'cross-sha256';
import * as base64 from '@juanelas/base64';

export interface PollingService {

  get frequency(): number;

  poll(): Promise<void>;

  stop(): void;

  attributeHeader(header: string): Promise<void>;
}

export type FeaturesFunction = (environments: Array<FeatureEnvironmentCollection>) => void;

export abstract class PollingBase implements PollingService {
  protected url: string;
  protected _frequency: number;
  protected _callback: FeaturesFunction;
  protected _stopped = false;
  protected _header?: string;
  protected _shaHeader: string;
  protected _etag: string;

  protected constructor(url: string, frequency: number, callback: FeaturesFunction) {
    this.url = url;
    this._frequency = frequency;
    this._shaHeader = '0';
    this._callback = callback;
  }

  attributeHeader(header: string): Promise<void> {
    this._header = header;
    this._shaHeader = (header === undefined || header.length === 0) ? '0' :
      base64.encode(new sha256().update(header).digest(), true, false);
    return this.poll();
  }

  public stop(): void {
    this._stopped = true;
  }

  public get frequency(): number {
    return this._frequency;
  }

  public abstract poll(): Promise<void>;

  /**
   * Allow the cache control settings on the server override this polling _frequency
   * @param cacheHeader
   */
  public parseCacheControl(cacheHeader: string | undefined) {
    const maxAge = cacheHeader?.match(/max-age=(\d+)/);
    if (maxAge) {
      let newFreq = parseInt(maxAge[1], 10);
      if (newFreq > 0) {
        this._frequency = newFreq * 1000;
      }
    }
  }

  // this is a dead  function but if we don't include it
  // then node will fail
  // eslint-disable-next-line require-await
  protected async delayTimer(): Promise<void> {
    return new Promise(((resolve) => {
      resolve();
    }));
  }
}

export interface NodejsOptions {
  timeout?: number;
}

export interface BrowserOptions {
  timeout?: number;
}

class BrowserPollingService extends PollingBase implements PollingService {
  private readonly _options: BrowserOptions;

  constructor(options: BrowserOptions, url: string, frequency: number, callback: FeaturesFunction) {
    super(url, frequency, callback);

    this._options = options;
  }



  public poll(): Promise<void> {
    if (this._stopped) {
      return new Promise((resolve) => {
        resolve();
      });
    }
    return new Promise((resolve, reject) => {
      const req = new XMLHttpRequest();
      const calculatedUrl = `${this.url}&contextSha=${this._shaHeader}`;
      req.open('GET', calculatedUrl);
      req.setRequestHeader('Content-type', 'application/json');

      if (this._etag) {
        req.setRequestHeader('if-none-match', this._etag);
      }

      if (this._header) {
        req.setRequestHeader('x-featurehub', this._header);
      }

      req.send();

      req.onreadystatechange = () => {
        if (req.readyState === 4) {
          if (req.status === 200 || req.status == 236) {
            this._etag = req.getResponseHeader('etag');
            this.parseCacheControl(req.getResponseHeader('cache-control'));

            this._callback(JSON.parse(req.responseText) as Array<FeatureEnvironmentCollection>);

            this._stopped = (req.status === 236);
            resolve();
          } else if (req.status == 304) { // no change
            resolve();
          } else {
            reject(req.status);
          }
        }
      };
    });
  }
}

export type PollingClientProvider = (options: BrowserOptions, url: string,
                                     frequency: number, callback: FeaturesFunction) => PollingBase;

export class FeatureHubPollingClient implements EdgeService {
  private readonly _frequency: number;
  private readonly _url: string;
  private _repository: InternalFeatureRepository;
  private _pollingService: PollingService | undefined;
  private readonly _options: BrowserOptions | NodejsOptions;
  private _startable: boolean;
  private readonly _config: FeatureHubConfig;
  private _xHeader: string;
  private _pollPromiseResolve: (value: (PromiseLike<void> | void)) => void;
  private _pollPromiseReject: (reason?: any) => void;
  private _pollingStarted = false;

  public static pollingClientProvider: PollingClientProvider = (opt, url, freq, callback) =>
    new BrowserPollingService(opt, url, freq, callback);

  constructor(repository: InternalFeatureRepository,
    config: FeatureHubConfig,
    frequency: number,
    options: BrowserOptions | NodejsOptions = {}) {
    this._frequency = frequency;
    this._repository = repository;
    this._options = options;
    this._config = config;
    this._url = config.getHost() + 'features?' + config.getApiKeys().map(e => 'apiKey=' + encodeURIComponent(e)).join('&');
  }

  private _initService(): void {
    if (this._pollingService === undefined) {
      this._pollingService =
        FeatureHubPollingClient.pollingClientProvider(this._options, this._url,
          this._frequency,
          (e) =>
            this.response(e));

      fhLog.log(`featurehub: initialized polling client to ${this._url}`);
    }
  }

  public contextChange(header: string): Promise<void> {
    if (!this._config.clientEvaluated()) {
      if (this._xHeader !== header) {
        this._xHeader = header;

        this._initService();

        const pollForContext = this._pollingService.attributeHeader(header);

        if (!this._pollingStarted) {
          this._restartTimer();
        }

        return pollForContext;
      }
    } else {
      return new Promise<void>((resolve) => resolve());
    }
  }

  public clientEvaluated(): boolean {
    return this._config.clientEvaluated();
  }

  public requiresReplacementOnHeaderChange(): boolean {
    return false;
  }

  public close(): void {
    if (this._pollingService) {
      this._pollingService.stop();
    }
  }

  public poll(): Promise<void> {
    if (this._pollPromiseResolve !== undefined || this._pollingStarted) {
      return new Promise<void>((resolve) => resolve());
    }

    this._initService();

    return new Promise<void>((resolve, reject) => {
      this._pollPromiseReject = reject;
      this._pollPromiseResolve = resolve;

      this._restartTimer();
    });
  }

  private stop() {
    this._pollingService.stop();
    this._pollingService = undefined;
  }

  private _restartTimer() {
    if (this._pollingService === undefined || this._pollingStarted) {
      return;
    }

    this._pollingStarted = true;

    this._pollFunc();
  }

  private _pollFunc() {
    this._pollingService.poll()
      .then(() => {
        if (this._pollPromiseResolve !== undefined) {
          try {
            this._pollPromiseResolve();
          } catch (e) {
            fhLog.error('Failed to process resolve', e);
          }
        }

        this._pollPromiseReject = undefined;
        this._pollPromiseResolve = undefined;
      })
      .catch((status) => {
        if (status === 404) {
          fhLog.error('The API Key provided does not exist, stopping polling.');
          this._repository.notify(SSEResultState.Failure, null);
          this.stop();

          if (this._pollPromiseReject) {
            try {
              this._pollPromiseReject(status);
            } catch (e) {
              fhLog.error('Failed to process reject', e);
            }
          }

          this._pollPromiseReject = undefined;
          this._pollPromiseResolve = undefined;
        } else if (status == 503) {
          fhLog.log('The backend is not ready, waiting for the next poll.');
        }
      }).finally(() => {
        // ready to poll again at the right interval
        this._pollingStarted = false;
        if (this._pollingService) { // in case we got a 404, and it was shut down
          setTimeout(() => this._restartTimer(),  this._pollingService.frequency);
        }
      });
  }

  private response(environments: Array<FeatureEnvironmentCollection>): void {
    if (environments.length === 0) {
      this._startable = false;
      this.stop();
      this._repository.notify(SSEResultState.Failure, null);
    } else {
      const features = new Array<FeatureState>();

      environments.forEach(e => {
        if (e.features.length > 0) {
          // set the environment id so each feature knows which environment it comes from
          e.features.forEach(f => {
            f.environmentId = e.id;
          });
          features.push(...e.features);
        }
      });

      this._repository.notify(SSEResultState.Features, features);
    }
  }

}
