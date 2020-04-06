// @flow strict-local

import SourceMap from '@parcel/source-map';
import {Optimizer} from '@parcel/plugin';
import postcss from 'postcss';
// flowlint-next-line untyped-import:off
import cssnano from 'cssnano';

const sentinelPath = '@@parcel-cssnano-optimizer';

export default new Optimizer({
  async optimize({
    bundle,
    contents: prevContents,
    getSourceMapReference,
    map: prevMap,
    options,
  }) {
    if (!bundle.env.minify) {
      return {contents: prevContents, map: prevMap};
    }

    if (typeof prevContents !== 'string') {
      throw new Error(
        'CSSNanoOptimizer: Only string contents are currently supported',
      );
    }

    const result = await postcss([cssnano]).process(prevContents, {
      // Postcss uses a `from` path and seems to include it as a source.
      // In our case, the previous map contains all the needed sources.
      // Provide a known sentinel path to use as the source, and filter it out
      // from the produced sources below.
      from: sentinelPath,
      map: {
        annotation: false,
        inline: false,
        prev: prevMap ? await prevMap.stringify({}) : null,
      },
    });

    let map;
    if (result.map != null) {
      map = new SourceMap();
      let {mappings, sources, names} = result.map.toJSON();
      map.addRawMappings(
        mappings,
        sources.filter(source => source !== sentinelPath),
        names,
      );
    }

    let contents = result.css;
    if (options.sourceMaps) {
      let reference = await getSourceMapReference(map);
      if (reference != null) {
        contents += '\n' + '/*# sourceMappingURL=' + reference + ' */\n';
      }
    }

    return {
      contents,
      map,
    };
  },
});
