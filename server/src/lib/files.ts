import { map } from '../promisify';
import { getFileExt } from './utility';

const MemoryStream = require('memorystream');
const path = require('path');
const Promise = require('bluebird');
const Random = require('random-js');
const AWS = require('./aws');

const KEYS_PER_REQUEST = 1000; // Max is 1000.
const MP3_EXT = '.mp3';
const TEXT_EXT = '.txt';
const CONVERTABLE_EXTS = ['.ogg', '.m4a'];
const CONFIG_PATH = path.resolve(__dirname, '../../..',
                                 'config.json');
const config = require(CONFIG_PATH);
const BUCKET_NAME = config.BUCKET_NAME || 'common-voice-corpus';

export default class Files {
  private s3: any;
  private files: {
    // fileGlob: [
    //   sentence: 'the text of the sentenct'
    // ]
  };
  private paths: string[];
  private randomEngine: any

  constructor() {
    this.s3 = new AWS.S3();
    this.files = {};
    this.paths = [];

    this.randomEngine = Random.engines.mt19937();
    this.randomEngine.autoSeed();
  }

  /**
   * Returns the file path with extension stripped.
   */
  private getGlob(path: string): string {
    return path.substr(0, path.indexOf('.'));
  }

  /**
   * Read a sentence in from s3.
   */
  private fetchSentenceFromS3(glob: string): Promise<string> {
    let key = glob + TEXT_EXT;
    return new Promise((res, rej) => {
      let glob = this.getGlob(key);
      let params = {Bucket: BUCKET_NAME, Key: key};
      this.s3.getObject(params, (err: any, s3Data: any) => {
        if (err) {
          console.error('Could not read from s3', key, err);
          rej(err);
          return;
        }

        let sentence = s3Data.Body.toString();
        this.files[glob].sentence = sentence;
        res(sentence);
      });
    });
  }

  /**
   * Fetch a public url for the resource.
   */
  private getPublicUrl(key: string) {
    return this.s3.getSignedUrl('getObject', {
      Bucket: BUCKET_NAME,
      Key: key
    });
  }

  /**
   * Load a single set of file keys based on KEYS_PER_REQUEST.
   */
  private loadNext(res: Function, rej: Function,continuationToken?: string): void {
    let awsRequest = this.s3.listObjectsV2({
      Bucket: BUCKET_NAME,
      MaxKeys: KEYS_PER_REQUEST,
      ContinuationToken: continuationToken
    });

    awsRequest.on('success', (response) => {
      let next = response['data']['NextContinuationToken'];
      let contents = response['data']['Contents'];
      for (let i = 0; i < contents.length; i++) {
        let key = contents[i].Key;
        let glob = this.getGlob(key);
        let ext = getFileExt(key);

        // Ignore non-text files
        if (ext !== TEXT_EXT && ext !== MP3_EXT) {
          continue;
        }

        // Track globs and sentence of the voice clips.
        if (!this.files[glob]) {
          this.files[glob] = {}
        }

        // Is it text or audio?
        if (ext === TEXT_EXT) {
          this.files[glob].text = key;
        } else if (ext === MP3_EXT) {
          this.files[glob].sound = key;
        }

        // If we have both text and audio, add it to our random pool.
        if (this.files[glob].text && this.files[glob].sound) {
          this.paths.push(glob);
        }
      }

      if (next) {
        console.log('loaded so far', this.paths.length);
        // Start the next bactch after a short delay
        this.loadNext(res, rej, next);
      } else {
        console.log('clips loaded', this.paths.length);
        res();
      }
    });

    awsRequest.on('error', (response) => {
      console.error('Error while fetching clip list', response);
    });

    awsRequest.send();
  }

  /**
   * Load sound file metadata into memory.
   */
  private loadCache(): Promise<void> {
    return new Promise((res, rej) => {
      this.loadNext(res, rej);
    });
  }

  /**
   * Fetch a random clip but make sure it's not the current user's.
   */
  private getGlobNotFromMe(myUid: string) {
    let distribution = Random.integer(0, this.paths.length - 1);
    let glob;
    do {
      glob = this.paths[distribution(this.randomEngine)];
    } while (glob.includes(myUid));
    return glob;
  }

  /**
   * Prepare a list of files from s3.
   */
  init(): Promise<void> {
    return this.loadCache();
  }

  /**
   * Grab a random sentence url and mp3 url.
   */
  getRandomClipJson(uid: string): Promise<string> {
    let glob = this.getGlobNotFromMe(uid);
    let info = this.files[glob];
    let clipJson = {
      glob: glob,
      text: info.sentence,
      sound: this.getPublicUrl(info.sound),
    };

    if (clipJson.text) {
      return Promise.resolve(JSON.stringify(clipJson));
    }

    return this.fetchSentenceFromS3(glob).then(sentence => {
      clipJson.text = sentence;
      return Promise.resolve(JSON.stringify(clipJson));
    });
  }

  /**
   * Grab a random sentence and associated sound file path.
   */
  getRandomClip(uid: string): Promise<string[2]> {
    // Make sure we have at least 1 file to choose from.
    if (this.paths.length === 0) {
      return Promise.reject('No files.');
    }

    let glob = this.getGlobNotFromMe(uid);

    // Grab clip metadata.
    let info = this.files[glob];
    let soundfile = glob + MP3_EXT;
    if (!info || !info.text || !info.sound) {
      console.error('unidentified random glob', glob);
      return Promise.reject('glob info not found');
    }

    // If we have a cached sentence, return it immediately.
    if (info.sentence && /\S/.test(info.sentence)) {
      return Promise.resolve([soundfile, info.sentence]);
    }

    // Grab the sentence contence from s3.
    return this.fetchSentenceFromS3(glob).then(sentence => {
      return Promise.resolve([soundfile, info.sentence]);
    });
  }
}
