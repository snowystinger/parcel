// @flow strict-local

import type {
  Asset as IAsset,
  Bundle as IBundle,
  BundleGroup,
  CreateBundleOpts,
  Dependency as IDependency,
  GraphVisitor,
  MutableBundleGraph as IMutableBundleGraph,
  BundlerBundleGraphTraversable,
  Target,
} from '@parcel/types';
import type {ParcelOptions} from '../types';

import invariant from 'assert';
import nullthrows from 'nullthrows';
import {DefaultWeakMap, md5FromString} from '@parcel/utils';
import InternalBundleGraph from '../BundleGraph';
import {Bundle, bundleToInternalBundle} from './Bundle';
import {mapVisitor, ALL_EDGE_TYPES} from '../Graph';
import {assetFromValue, assetToAssetValue} from './Asset';
import {getBundleGroupId} from '../utils';
import Dependency, {dependencyToInternalDependency} from './Dependency';
import {environmentToInternalEnvironment} from './Environment';
import {targetToInternalTarget} from './Target';
import {HASH_REF_PREFIX} from '../constants';

const internalMutableBundleGraphToMutableBundleGraph: DefaultWeakMap<
  ParcelOptions,
  WeakMap<InternalBundleGraph, MutableBundleGraph>,
> = new DefaultWeakMap(() => new WeakMap());

export default class MutableBundleGraph implements IMutableBundleGraph {
  #graph; // InternalBundleGraph
  #options; // ParcelOptions

  constructor(graph: InternalBundleGraph, options: ParcelOptions) {
    let existing = internalMutableBundleGraphToMutableBundleGraph
      .get(options)
      .get(graph);
    if (existing != null) {
      return existing;
    }
    this.#graph = graph;
    this.#options = options;

    internalMutableBundleGraphToMutableBundleGraph
      .get(options)
      .set(graph, this);
  }

  addAssetGraphToBundle(asset: IAsset, bundle: IBundle) {
    this.#graph.addAssetGraphToBundle(
      assetToAssetValue(asset),
      bundleToInternalBundle(bundle),
    );
  }

  createBundleGroup(dependency: IDependency, target: Target): BundleGroup {
    let dependencyNode = this.#graph._graph.getNode(dependency.id);
    if (!dependencyNode) {
      throw new Error('Dependency not found');
    }

    let resolved = this.#graph.getDependencyResolution(
      dependencyToInternalDependency(dependency),
    );
    if (!resolved) {
      throw new Error(
        'Dependency did not resolve to an asset ' + dependency.id,
      );
    }

    let bundleGroup: BundleGroup = {
      target,
      entryAssetId: resolved.id,
    };

    let bundleGroupNode = {
      id: getBundleGroupId(bundleGroup),
      type: 'bundle_group',
      value: bundleGroup,
    };

    this.#graph._graph.addNode(bundleGroupNode);
    let assetNodes = this.#graph._graph.getNodesConnectedFrom(dependencyNode);
    this.#graph._graph.addEdge(dependencyNode.id, bundleGroupNode.id);
    this.#graph._graph.replaceNodesConnectedTo(bundleGroupNode, assetNodes);
    this.#graph._graph.addEdge(dependencyNode.id, resolved.id, 'references');
    this.#graph._graph.removeEdge(dependencyNode.id, resolved.id);

    if (dependency.isEntry) {
      this.#graph._graph.addEdge(
        nullthrows(this.#graph._graph.getRootNode()).id,
        bundleGroupNode.id,
        'bundle',
      );
    } else {
      let inboundBundleNodes = this.#graph._graph.getNodesConnectedTo(
        dependencyNode,
        'contains',
      );
      for (let inboundBundleNode of inboundBundleNodes) {
        invariant(inboundBundleNode.type === 'bundle');
        this.#graph._graph.addEdge(
          inboundBundleNode.id,
          bundleGroupNode.id,
          'bundle',
        );
      }
    }

    return bundleGroup;
  }

  removeBundleGroup(bundleGroup: BundleGroup): void {
    for (let bundle of this.getBundlesInBundleGroup(bundleGroup)) {
      this.#graph._graph.removeById(bundle.id);
    }
    this.#graph._graph.removeById(getBundleGroupId(bundleGroup));
  }

  resolveExternalDependency(
    dependency: IDependency,
    bundle?: IBundle,
  ): ?(
    | {|type: 'bundle_group', value: BundleGroup|}
    | {|type: 'asset', value: IAsset|}
  ) {
    let resolved = this.#graph.resolveExternalDependency(
      dependencyToInternalDependency(dependency),
      bundle && bundleToInternalBundle(bundle),
    );

    if (resolved == null) {
      return;
    } else if (resolved.type === 'bundle_group') {
      return resolved;
    }

    return {
      type: 'asset',
      value: assetFromValue(resolved.value, this.#options),
    };
  }

  internalizeAsyncDependency(bundle: IBundle, dependency: IDependency): void {
    this.#graph.internalizeAsyncDependency(
      bundleToInternalBundle(bundle),
      dependencyToInternalDependency(dependency),
    );
  }

  createBundle(opts: CreateBundleOpts): Bundle {
    let entryAsset = opts.entryAsset
      ? assetToAssetValue(opts.entryAsset)
      : null;

    let target = targetToInternalTarget(opts.target);
    let bundleId = md5FromString(
      'bundle:' +
        (opts.uniqueKey ?? nullthrows(entryAsset?.id)) +
        target.distDir,
    );
    let bundleNode = {
      type: 'bundle',
      id: bundleId,
      value: {
        id: bundleId,
        hashReference: HASH_REF_PREFIX + bundleId,
        type: opts.type ?? nullthrows(entryAsset).type,
        env: opts.env
          ? environmentToInternalEnvironment(opts.env)
          : nullthrows(entryAsset).env,
        entryAssetIds: entryAsset ? [entryAsset.id] : [],
        pipeline: entryAsset ? entryAsset.pipeline : null,
        filePath: null,
        isEntry: opts.isEntry,
        isInline: opts.isInline,
        isSplittable: opts.isSplittable ?? entryAsset?.isSplittable,
        target,
        name: null,
        displayName: null,
        stats: {size: 0, time: 0},
      },
    };

    this.#graph._graph.addNode(bundleNode);

    if (opts.entryAsset) {
      this.#graph._graph.addEdge(bundleNode.id, opts.entryAsset.id);
    }
    return new Bundle(bundleNode.value, this.#graph, this.#options);
  }

  addBundleToBundleGroup(bundle: IBundle, bundleGroup: BundleGroup) {
    let bundleGroupId = getBundleGroupId(bundleGroup);
    this.#graph._graph.addEdge(bundleGroupId, bundle.id);
    this.#graph._graph.addEdge(bundleGroupId, bundle.id, 'bundle');

    for (let entryAsset of bundle.getEntryAssets()) {
      if (this.#graph._graph.hasEdge(bundleGroupId, entryAsset.id)) {
        this.#graph._graph.removeEdge(bundleGroupId, entryAsset.id);
      }
    }
  }

  createAssetReference(dependency: IDependency, asset: IAsset): void {
    return this.#graph.createAssetReference(
      dependencyToInternalDependency(dependency),
      assetToAssetValue(asset),
    );
  }

  getDependencyAssets(dependency: IDependency): Array<IAsset> {
    return this.#graph
      .getDependencyAssets(dependencyToInternalDependency(dependency))
      .map(asset => assetFromValue(asset, this.#options));
  }

  getDependencyResolution(dependency: IDependency): ?IAsset {
    let resolved = this.#graph.getDependencyResolution(
      dependencyToInternalDependency(dependency),
    );

    if (resolved) {
      return assetFromValue(resolved, this.#options);
    }
  }

  getSiblingBundles(bundle: IBundle): Array<IBundle> {
    return this.#graph
      .getSiblingBundles(bundleToInternalBundle(bundle))
      .map(bundle => new Bundle(bundle, this.#graph, this.#options));
  }

  traverse<TContext>(
    visit: GraphVisitor<BundlerBundleGraphTraversable, TContext>,
  ): ?TContext {
    return this.#graph._graph.filteredTraverse(
      node => {
        if (node.type === 'asset') {
          return {
            type: 'asset',
            value: assetFromValue(node.value, this.#options),
          };
        } else if (node.type === 'dependency') {
          return {type: 'dependency', value: new Dependency(node.value)};
        }
      },
      visit,
      undefined, // start with root
      // $FlowFixMe
      ALL_EDGE_TYPES,
    );
  }

  findBundlesWithAsset(asset: IAsset): Array<IBundle> {
    return this.#graph
      .findBundlesWithAsset(assetToAssetValue(asset))
      .map(bundle => new Bundle(bundle, this.#graph, this.#options));
  }

  findBundlesWithDependency(dependency: IDependency): Array<IBundle> {
    return this.#graph
      .findBundlesWithDependency(dependencyToInternalDependency(dependency))
      .map(bundle => new Bundle(bundle, this.#graph, this.#options));
  }

  getBundleGroupsContainingBundle(bundle: IBundle): Array<BundleGroup> {
    return this.#graph.getBundleGroupsContainingBundle(
      bundleToInternalBundle(bundle),
    );
  }

  getBundlesInBundleGroup(bundleGroup: BundleGroup): Array<IBundle> {
    return this.#graph
      .getBundlesInBundleGroup(bundleGroup)
      .map(bundle => new Bundle(bundle, this.#graph, this.#options));
  }

  getParentBundlesOfBundleGroup(bundleGroup: BundleGroup): Array<IBundle> {
    return this.#graph
      .getParentBundlesOfBundleGroup(bundleGroup)
      .map(bundle => new Bundle(bundle, this.#graph, this.#options));
  }

  getTotalSize(asset: IAsset): number {
    return this.#graph.getTotalSize(assetToAssetValue(asset));
  }

  isAssetInAncestorBundles(bundle: IBundle, asset: IAsset): boolean {
    return this.#graph.isAssetInAncestorBundles(
      bundleToInternalBundle(bundle),
      assetToAssetValue(asset),
    );
  }

  removeAssetGraphFromBundle(asset: IAsset, bundle: IBundle) {
    this.#graph.removeAssetGraphFromBundle(
      assetToAssetValue(asset),
      bundleToInternalBundle(bundle),
    );
  }

  traverseBundles<TContext>(visit: GraphVisitor<IBundle, TContext>): ?TContext {
    return this.#graph.traverseBundles(
      mapVisitor(
        bundle => new Bundle(bundle, this.#graph, this.#options),
        visit,
      ),
    );
  }

  traverseContents<TContext>(
    visit: GraphVisitor<BundlerBundleGraphTraversable, TContext>,
  ): ?TContext {
    return this.#graph.traverseContents(
      mapVisitor(
        node =>
          node.type === 'asset'
            ? {type: 'asset', value: assetFromValue(node.value, this.#options)}
            : {
                type: 'dependency',
                value: new Dependency(node.value),
              },
        visit,
      ),
    );
  }
}
