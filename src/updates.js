const { getUpdateStatus } = require('./update-check');
const packageInfo = require('../package.json');
const { createUpdateInstaller } = require('./update-install');

const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const RETRY_INTERVAL = 5 * 60 * 1000;

class Updates {
  constructor({ currentVersion = packageInfo.version,
    upstreamVersion = currentVersion === packageInfo.version && packageInfo.clideckUpdatePolicy === 'local'
      ? packageInfo.clideckUpstreamVersion : undefined, check = getUpdateStatus,
    installer = createUpdateInstaller(), onChange = () => {}, now = Date.now,
    schedule = setTimeout, cancel = clearTimeout } = {}) {
    this.currentVersion = currentVersion;
    this.comparisonVersion = upstreamVersion || currentVersion;
    this.checkRegistry = check;
    this.installer = installer;
    this.onChange = onChange;
    this.now = now;
    this.schedule = schedule;
    this.cancel = cancel;
    this.state = { type: 'engine.update', state: 'checking', currentVersion, canInstall: false };
    this.checking = null;
    this.installing = null;
    this.timer = null;
    this.lastCheck = -Infinity;
    this.closed = false;
  }

  snapshot() { return { ...this.state }; }

  publish(fields) {
    this.state = { type: 'engine.update', currentVersion: this.currentVersion, ...fields };
    if (!this.closed) this.onChange(this.snapshot());
    return this.snapshot();
  }

  check() {
    if (this.closed || this.installing || this.state.state === 'installed') return Promise.resolve(this.snapshot());
    if (this.checking) return this.checking;
    if (this.now() - this.lastCheck < 10_000) return Promise.resolve(this.snapshot());
    this.lastCheck = this.now();
    this.cancel(this.timer);
    this.publish({ ...this.state, state: 'checking', error: undefined });
    this.checking = Promise.resolve().then(async () => {
      try {
        const [result, capability] = await Promise.all([
          this.checkRegistry({ currentVersion: this.comparisonVersion }), this.installer.capability(),
        ]);
        this.publish({ ...capability, ...result });
      } catch {
        this.publish({ canInstall: false, state: 'error', error: 'Could not check for updates. Please try again.' });
      } finally {
        this.checking = null;
        if (!this.closed) {
          this.timer = this.schedule(() => { void this.check(); },
            this.state.state === 'error' ? RETRY_INTERVAL : CHECK_INTERVAL);
          this.timer?.unref?.();
        }
      }
      return this.snapshot();
    });
    return this.checking;
  }

  install() {
    if (this.installing) return this.installing;
    // Client supplies no command, destination, or version. Only our checked offer is installable.
    if (this.closed || this.checking || !this.state.canInstall
      || !['available', 'error'].includes(this.state.state) || !this.state.latestVersion) return Promise.resolve(this.snapshot());
    const version = this.state.latestVersion;
    this.cancel(this.timer);
    this.publish({ ...this.state, state: 'installing', error: undefined });
    this.installing = Promise.resolve().then(async () => {
      try {
        await this.installer.install(version);
        this.publish({ canInstall: false, state: 'installed', latestVersion: version,
          instruction: 'Update installed. Restart CliDeck when you are ready.' });
      } catch (error) {
        this.publish({ canInstall: true, state: 'error', latestVersion: version,
          error: error.message || 'The update could not be completed. Please try again.' });
      } finally { this.installing = null; }
      return this.snapshot();
    });
    return this.installing;
  }

  async close() {
    this.closed = true;
    this.cancel(this.timer);
    // Do not exit midway through an npm replacement already authorized by the user.
    if (this.installing) await this.installing;
  }
}

module.exports = { Updates };
