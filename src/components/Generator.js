// @flow

/**
 * Genertaor is a Component that renders the components, layouts
 * with the a given componentTree which is created by qa-compiler
 *
 * First Step, prerender the tree in constructor, this action will add a
 * React Component with all hocs it needs in every node
 *
 * Second Step, take the node.component to render it, and give the component
 * some props it maybe needs such as renderChildren
 */

import * as React from 'react';
import Loadable from 'react-loadable';
import {Item} from '@canner/react-cms-helpers';
import get from 'lodash/get';
import isUndefined from 'lodash/isUndefined';
import mapValues from 'lodash/mapValues';
import RefId from 'canner-ref-id';

function defaultHoc(Component) {
  return Component;
}

function isComponent(node) {
  return node.nodeType && node.nodeType.startsWith('plugins');
}

function isLayout(node) {
  return node.nodeType === 'layout';
}

function isFieldset(node) {
  return node.nodeType === 'plugins.object.fieldset';
}

export type Node = {
  keyName: string,
  nodeType: string,
  hocs: Array<string>,
  children: Array<Node>,
  component: React.ComponentType<*>,
  loader: Promise<*>
} 

type Props = {
  componentTree: {[string]: Node},
  hocs: {[string]: React.ComponentType<*>},
  layouts: {[string]: React.ComponentType<*>},
  imageServiceConfigs: Object,

  goTo: (path: string) => void,
  baseUrl: string,
  routes: Array<string>,
  params: {[string]: string},
  cache: boolean
}

type childrenProps = {
  refId: RefId,
  [string]: any
};

type State = {
  componentTree: {[string]: any},
  error: any,
  errorInfo: string
}

export default class Generator extends React.PureComponent<Props, State> {
  cacheTree: {
    [key: string]: Node
  } // store the prerenders tree
  idNodeMap = {}
  constructor(props: Props) {
    // prerender the tree in constructor, this action will add a
    // React Component with all hocs it needs in every node
    super(props);
    const {componentTree, routes} = props;
    const activeKey = routes[0] || Object.keys(componentTree)[0];
    this.cacheTree = this.genCacheTree(componentTree);
    this.state = {
      componentTree: this.cacheTree[activeKey],
      error: null,
      errorInfo: ''
    };
  }

  componentWillReceiveProps(nextProps: Props) {
    if (!nextProps.cache) {
      this.cacheTree = this.genCacheTree(nextProps.componentTree);
    }
    this.setState({
      componentTree: this.cacheTree[nextProps.routes[0] || Object.keys(nextProps.componentTree)[0]],
    });
  }

  componentDidCatch(error: any, errorInfo: string) {
    // Catch errors in any components below and re-render with error message
    this.setState({
      error: error,
      errorInfo: errorInfo
    })
    // You can also log error messages to an error reporting service here
  }

  genCacheTree = (tree: {[string]: Node}): {[string]: Node} => {
    return mapValues(tree, (branch) => {
      return this.prerender(branch);
    });
  }

  static defaultProps = {
    componentTree: {},
    layouts: {},
    hocs: {}
  }

  // wrap the plugin with hoc if it has
  prerender = (node: Node): Node => {
    // add a field `component` in every node.
    // it's a React Component with all hocs it needs in every node
    const {layouts} = this.props;
    let component;
    if (isLayout(node)) {
      component = get(layouts, node.component);
      component = this.wrapByHOC(component, (node.hocs || ['containerRouter']).slice() || []);
    } else if (isComponent(node)) { // TODO: need to fix, turn plugins to components in compiler

      if (isFieldset(node)) {
        component = () => <Item />;
      } else {
        component = Loadable({
          loader: () => node.loader,
          loading: () => <div>loading</div>,
        });
      }
      component = this.wrapByHOC(component, node.hocs.slice() || []);
    }

    if (!component) {
      throw new Error(`invalid node, name: ${node.keyName}, nodeType: ${node.nodeType}`);
    }

    node.component = component;
    if (node.children) {
      node.children = node.children.map((child) => {
        return this.prerender(child);
      });
    }
    return node;
  }

  wrapByHOC = (component: React.ComponentType<*>, hocNames: Array<string>): React.ComponentType<*> => {
    // find hocs and wrap the component
    const {hocs} = this.props;
    while (hocNames.length) {
      const hocName = hocNames.shift();
      const hoc = get(hocs, hocName, defaultHoc);
      component = hoc(component);
    }
    return component;
  }

  renderNode = (node: Node, index: number, props: childrenProps): React$Node => {
    // take the node.component to render it, and give the component
    // some props it maybe needs such as renderChildren
    // eslint-disable-next-line no-unused-vars
    if (!node) {
      throw new Error(`Unexpected Error: Want to render a undefined node with refId '${props.refId.toString()}'`);
    }

    const {component, ...restNodeData} = node;
    const {params, goTo, baseUrl, routes, imageServiceConfigs} = this.props;
    if (component) {
      return <node.component
        {...restNodeData}
        key={index}
        imageServiceConfig={(imageServiceConfigs || {})[routes[0]]}
        renderChildren={(props) => this.renderChildren(node, props)}
        renderComponent={this.renderComponent}
        params={params}
        goTo={path => {
          goTo(`${baseUrl}/${path}`)}
        }
        {...props}
      />;
    }
    return null;
  }

  static findNode = (pathArr: Array<string>, node: Node): ?Node => {
    if (isComponent(node) && node.keyName === pathArr[0]) {
      pathArr = pathArr.slice(1);
      if (!pathArr.length) {
        return node;
      }
    }

    if (node.children) {
      return node.children
        .map(child => Generator.findNode(pathArr, child))
        .find(node => !!node);
    }
  }

  renderComponent = (refId: RefId, props: childrenProps): React$Node => {
    const componentPathArr = refId.getPathArr()
      .filter(path => isNaN(Number(path)));
    const componentPath = componentPathArr.join('/');
    let node = this.idNodeMap[componentPath];
    const entryKey = componentPathArr[0];
    if (!node) {
      const node = Generator.findNode(componentPathArr.slice(), this.cacheTree[entryKey]);
      this.idNodeMap[componentPath] = node;
    }
    if (!node) {
      throw new Error(`Can't find the node at refId ${refId.toString()}`);
    }
    return this.renderNode(node, 0, {refId, ...props});
  }

  renderChildren = (node: Node, props: childrenProps | Node => childrenProps): React$Node => {
    // just get the props and call renderNode
    // this method is called by components themselves
    const {children} = node;
    if (children) {
      return children.map((child, index) => {
        const childrenProps = typeof props === 'function' ? props(child) : props;
        const {refId} = childrenProps;
        if (isUndefined(refId)) {
          throw new Error(`refId is required for renderChildren, please check node '${node.keyName || ''}'`);
        }
        if (childrenProps.hidden) {
          return null;
        }
        return this.renderNode(child, index, childrenProps);
      });
    }
    return null;
  }

  render() {
    const {componentTree, error, errorInfo} = this.state;
    const {routes, params} = this.props;
    if (error) {
      return errorInfo;
    }
    return (
      <div>
        {this.renderNode(componentTree, 0, {refId: new RefId(''), routes, params})}
      </div>
    );
  }
}
