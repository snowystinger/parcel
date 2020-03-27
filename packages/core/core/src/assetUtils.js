// @flow strict-local

import type {
  ASTGenerator,
  ConfigResult,
  File,
  FilePath,
  GenerateOutput,
  Meta,
  PackageName,
  Stats,
  Symbol,
  Transformer,
} from '@parcel/types';
import type {Asset, Dependency, Environment} from './types';

import {Readable} from 'stream';
import {PluginLogger} from '@parcel/logger';
import nullthrows from 'nullthrows';
import CommittedAsset from './CommittedAsset';
import UncommittedAsset from './UncommittedAsset';
import loadPlugin from './loadParcelPlugin';
import {Asset as PublicAsset} from './public/Asset';
import PluginOptions from './public/PluginOptions';
import {blobToStream, loadConfig, md5FromString} from '@parcel/utils';
import {getEnvironmentHash} from './Environment';

type AssetOptions = {|
  id?: string,
  committed?: boolean,
  hash?: ?string,
  idBase?: ?string,
  filePath: FilePath,
  type: string,
  contentKey?: ?string,
  mapKey?: ?string,
  astKey?: ?string,
  astGenerator?: ?ASTGenerator,
  dependencies?: Map<string, Dependency>,
  includedFiles?: Map<FilePath, File>,
  isIsolated?: boolean,
  isInline?: boolean,
  isSplittable?: ?boolean,
  isSource: boolean,
  env: Environment,
  meta?: Meta,
  outputHash?: ?string,
  pipeline?: ?string,
  stats: Stats,
  symbols?: Map<Symbol, Symbol>,
  sideEffects?: boolean,
  uniqueKey?: ?string,
  plugin?: PackageName,
  configPath?: FilePath,
|};

export function createAsset(options: AssetOptions): Asset {
  let idBase = options.idBase != null ? options.idBase : options.filePath;
  let uniqueKey = options.uniqueKey || '';
  return {
    id:
      options.id != null
        ? options.id
        : md5FromString(
            idBase + options.type + getEnvironmentHash(options.env) + uniqueKey,
          ),
    committed: options.committed ?? false,
    hash: options.hash,
    filePath: options.filePath,
    isIsolated: options.isIsolated == null ? false : options.isIsolated,
    isInline: options.isInline == null ? false : options.isInline,
    isSplittable: options.isSplittable,
    type: options.type,
    contentKey: options.contentKey,
    mapKey: options.mapKey,
    astKey: options.astKey,
    astGenerator: options.astGenerator,
    dependencies: options.dependencies || new Map(),
    includedFiles: options.includedFiles || new Map(),
    isSource: options.isSource,
    outputHash: options.outputHash,
    pipeline: options.pipeline,
    env: options.env,
    meta: options.meta || {},
    stats: options.stats,
    symbols: options.symbols || new Map(),
    sideEffects: options.sideEffects != null ? options.sideEffects : true,
    uniqueKey: uniqueKey,
    plugin: options.plugin,
    configPath: options.configPath,
  };
}

const generateResults: WeakMap<Asset, Promise<GenerateOutput>> = new WeakMap();

export function generateFromAST(
  asset: CommittedAsset | UncommittedAsset,
): Promise<GenerateOutput> {
  let output = generateResults.get(asset.value);
  if (output == null) {
    output = _generateFromAST(asset);
    generateResults.set(asset.value, output);
  }
  return output;
}

async function _generateFromAST(asset: CommittedAsset | UncommittedAsset) {
  let ast = await asset.getAST();
  if (ast == null) {
    throw new Error('Asset has no AST');
  }

  let pluginName = nullthrows(asset.value.plugin);
  let {plugin} = await loadPlugin<Transformer>(
    asset.options.packageManager,
    pluginName,
    nullthrows(asset.value.configPath),
    asset.options.autoinstall,
  );
  if (!plugin.generate) {
    throw new Error(`${pluginName} does not have a generate method`);
  }

  let {code, map} = await plugin.generate({
    asset: new PublicAsset(asset),
    ast,
    options: new PluginOptions(asset.options),
    logger: new PluginLogger({origin: pluginName}),
  });

  let mapBuffer = map?.toBuffer();
  // Store the results in the cache so we can avoid generating again next time
  await Promise.all([
    asset.options.cache.setStream(
      nullthrows(asset.value.contentKey),
      blobToStream(code),
    ),
    mapBuffer != null &&
      asset.options.cache.setBlob(nullthrows(asset.value.mapKey), mapBuffer),
  ]);

  return {
    code:
      code instanceof Readable
        ? asset.options.cache.getStream(nullthrows(asset.value.contentKey))
        : code,
    map,
  };
}

export async function getConfig(
  asset: CommittedAsset | UncommittedAsset,
  filePaths: Array<FilePath>,
  options: ?{|
    packageKey?: string,
    parse?: boolean,
  |},
): Promise<ConfigResult | null> {
  let packageKey = options?.packageKey;
  let parse = options && options.parse;

  if (packageKey != null) {
    let pkg = await asset.getPackage();
    if (pkg && pkg[packageKey]) {
      return pkg[packageKey];
    }
  }

  let conf = await loadConfig(
    asset.options.inputFS,
    asset.value.filePath,
    filePaths,
    parse == null ? null : {parse},
  );
  if (!conf) {
    return null;
  }

  return conf;
}
