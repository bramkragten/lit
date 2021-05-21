/**
 * @license
 * Copyright 2021 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */

import * as ts from 'typescript';
import {LitElementMutations} from './mutations.js';

type Visitor = ClassDecoratorTransformer | MemberDecoratorTransformer;

interface ClassDecoratorTransformer {
  kind: 'classDecorator';
  decoratorName: string;

  visit(
    mutations: LitElementMutations,
    class_: ts.ClassDeclaration,
    decorator: ts.Decorator
  ): void;
}

interface MemberDecoratorTransformer {
  kind: 'memberDecorator';
  decoratorName: string;

  visit(
    mutations: LitElementMutations,
    member: ts.ClassElement,
    decorator: ts.Decorator
  ): void;
}

const unreachable = (x: never) => x;

/**
 * Configurable transformer for LitElement classes.
 */
export class LitTransformer {
  private _context: ts.TransformationContext;

  private _classDecoratorVisitors = new Map<
    string,
    ClassDecoratorTransformer[]
  >();

  private _memberDecoratorVisitors = new Map<
    string,
    MemberDecoratorTransformer[]
  >();

  private _removeNodes = new Set<ts.Node>();

  constructor(context: ts.TransformationContext, visitors: Array<Visitor>) {
    this._context = context;
    for (const visitor of visitors) {
      if (visitor.kind === 'classDecorator') {
        let arr = this._classDecoratorVisitors.get(visitor.decoratorName);
        if (arr === undefined) {
          arr = [];
          this._classDecoratorVisitors.set(visitor.decoratorName, arr);
        }
        arr.push(visitor);
      } else if (visitor.kind === 'memberDecorator') {
        let arr = this._memberDecoratorVisitors.get(visitor.decoratorName);
        if (arr === undefined) {
          arr = [];
          this._memberDecoratorVisitors.set(visitor.decoratorName, arr);
        }
        arr.push(visitor);
      } else {
        throw new Error(
          `Internal error: unknown visitor kind ${
            (unreachable(visitor) as Visitor).kind
          }`
        );
      }
    }
  }

  visit = (node: ts.Node): ts.VisitResult<ts.Node> => {
    if (this._removeNodes.delete(node)) {
      return undefined;
    }
    if (ts.isImportDeclaration(node)) {
      return this._visitImportDeclaration(node);
    }
    if (ts.isClassDeclaration(node)) {
      return this._visitClassDeclaration(node);
    }
    return ts.visitEachChild(node, this.visit, this._context);
  };

  private _visitImportDeclaration(node: ts.ImportDeclaration) {
    if (
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === 'lit/decorators.js'
    ) {
      return undefined;
    }
    return node;
  }

  private _visitClassDeclaration(class_: ts.ClassDeclaration) {
    const mutations = new LitElementMutations();

    // Class decorators
    for (const decorator of class_.decorators ?? []) {
      if (
        !ts.isCallExpression(decorator.expression) ||
        !ts.isIdentifier(decorator.expression.expression)
      ) {
        continue;
      }
      const decoratorName = decorator.expression.expression.getText();
      const visitors = this._classDecoratorVisitors.get(decoratorName) ?? [];
      for (const visitor of visitors) {
        visitor.visit(mutations, class_, decorator);
      }
    }

    // Class member decorators
    for (const member of class_.members ?? []) {
      for (const decorator of member.decorators ?? []) {
        if (
          !ts.isCallExpression(decorator.expression) ||
          !ts.isIdentifier(decorator.expression.expression)
        ) {
          continue;
        }
        const decoratorName = decorator.expression.expression.getText();
        const visitors = this._memberDecoratorVisitors.get(decoratorName) ?? [];
        for (const visitor of visitors) {
          visitor.visit(mutations, member, decorator);
        }
      }
    }

    if (mutations.reactiveProperties.length > 0) {
      const existing = this._findExistingStaticProperties(class_);
      if (existing !== undefined) {
        this._removeNodes.add(existing.getter);
      }
      mutations.classMembers.unshift(
        this._createStaticProperties(
          existing?.properties,
          mutations.reactiveProperties
        )
      );
    }

    // Note `mutations.nodesToRemove` is scoped only to this class visitor, so
    // we copy the entries to this broader AST scoped visitor so that we can
    // identify nodes to delete as we descend down through `ts.visitEachChild`.
    for (const node of mutations.removeNodes) {
      this._removeNodes.add(node);
    }

    // Note we do need to `ts.visitEachChild` here, because [1] there might be
    // nodes that still need to be deleted via `this._nodesToRemove` (e.g. a
    // property decorator or a property itself), and [2] in theory there could
    // be a nested custom element definition somewhere in this class.
    const transformedClass = ts.visitEachChild(
      this._context.factory.updateClassDeclaration(
        class_,
        class_.decorators,
        class_.modifiers,
        class_.name,
        class_.typeParameters,
        class_.heritageClauses,
        [...mutations.classMembers, ...class_.members]
      ),
      this.visit,
      this._context
    );

    return [transformedClass, ...mutations.adjacentStatements];
  }

  /**
   * Create the AST from e.g. `@property({type: String}) myProperty`:
   *
   *   static get properties() {
   *     return {
   *       myProperty: { type: String },
   *       ...
   *     }
   *   }
   */
  private _createStaticProperties(
    existingProperties: ts.NodeArray<ts.ObjectLiteralElementLike> | undefined,
    newProperties: Array<{name: string; options?: ts.ObjectLiteralExpression}>
  ) {
    const f = this._context.factory;
    const properties = [
      ...(existingProperties ?? []),
      ...newProperties.map(({name, options}) =>
        f.createPropertyAssignment(
          f.createIdentifier(name),
          options ? options : f.createObjectLiteralExpression([], false)
        )
      ),
    ];
    return f.createGetAccessorDeclaration(
      undefined,
      [f.createModifier(ts.SyntaxKind.StaticKeyword)],
      f.createIdentifier('properties'),
      [],
      undefined,
      f.createBlock(
        [
          f.createReturnStatement(
            f.createObjectLiteralExpression(properties, true)
          ),
        ],
        true
      )
    );
  }

  private _findExistingStaticProperties(class_: ts.ClassDeclaration):
    | {
        getter: ts.ClassElement;
        properties: ts.NodeArray<ts.ObjectLiteralElementLike>;
      }
    | undefined {
    const getter = class_.members.find(
      (member) =>
        ts.isGetAccessor(member) &&
        ts.isIdentifier(member.name) &&
        member.name.getText() === 'properties'
    );
    if (
      getter === undefined ||
      !ts.isGetAccessorDeclaration(getter) ||
      getter.body === undefined
    ) {
      return undefined;
    }
    const returnStatement = getter.body.statements[0];
    if (
      returnStatement === undefined ||
      !ts.isReturnStatement(returnStatement)
    ) {
      return undefined;
    }
    const objectLiteral = returnStatement.expression;
    if (
      objectLiteral === undefined ||
      !ts.isObjectLiteralExpression(objectLiteral)
    ) {
      return undefined;
    }
    return {getter, properties: objectLiteral.properties};
  }
}