---
id: adapt.component
title: Component class
hide_title: true
---
<!-- Do not edit this file. It is automatically generated by API Documenter. -->

[@usys/adapt](./adapt.md) &gt; [Component](./adapt.component.md)

## Component class

<b>Signature:</b>

```typescript
export declare abstract class Component<Props extends object = {}, State extends object = {}> implements GenericInstanceMethods 
```

## Constructors

|  Constructor | Modifiers | Description |
|  --- | --- | --- |
|  [(constructor)(props)](./adapt.component.(constructor).md) |  | Constructs a new instance of the <code>Component</code> class |

## Properties

|  Property | Modifiers | Type | Description |
|  --- | --- | --- | --- |
|  [cleanup](./adapt.component.cleanup.md) |  | <code>(this: this) =&gt; void</code> |  |
|  [dependsOn](./adapt.component.dependson.md) |  | <code>DependsOnMethod</code> |  |
|  [deployedWhen](./adapt.component.deployedwhen.md) |  | <code>DeployedWhenMethod</code> |  |
|  [deployInfo](./adapt.component.deployinfo.md) |  | <code>DeployInfo</code> |  |
|  [props](./adapt.component.props.md) |  | <code>Props &amp; Partial&lt;BuiltinProps&gt;</code> |  |
|  [state](./adapt.component.state.md) |  | <code>Readonly&lt;State&gt;</code> |  |

## Methods

|  Method | Modifiers | Description |
|  --- | --- | --- |
|  [build(helpers)](./adapt.component.build.md) |  |  |
|  [initialState()](./adapt.component.initialstate.md) |  |  |
|  [ready(helpers)](./adapt.component.ready.md) |  |  |
|  [setState(stateUpdate)](./adapt.component.setstate.md) |  |  |
|  [status(observeForStatus, buildData)](./adapt.component.status.md) |  |  |