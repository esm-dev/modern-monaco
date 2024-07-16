/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from "./monaco.d.ts";

/**
 * Impacts the behavior and appearance of the validation message.
 */
/**
 * The severity level for input box validation.
 */
export enum InputBoxValidationSeverity {
  /**
   * Informational severity level.
   */
  Info = 1,
  /**
   * Warning severity level.
   */
  Warning = 2,
  /**
   * Error severity level.
   */
  Error = 3,
}

/**
 * Object to configure the behavior of the validation message.
 */
export interface InputBoxValidationMessage {
  /**
   * The validation message to display.
   */
  readonly message: string;

  /**
   * The severity of the validation message.
   * NOTE: When using `InputBoxValidationSeverity.Error`, the user will not be allowed to accept (hit ENTER) the input.
   * `Info` and `Warning` will still allow the InputBox to accept the input.
   */
  readonly severity: InputBoxValidationSeverity;
}

/**
 * Options to configure the behavior of the input box UI.
 */
export interface InputBoxOptions {
  /**
   * An optional string that represents the title of the input box.
   */
  title?: string;

  /**
   * The value to pre-fill in the input box.
   */
  value?: string;

  /**
   * Selection of the pre-filled {@linkcode InputBoxOptions.value value}. Defined as tuple of two number where the
   * first is the inclusive start index and the second the exclusive end index. When `undefined` the whole
   * pre-filled value will be selected, when empty (start equals end) only the cursor will be set,
   * otherwise the defined range will be selected.
   */
  valueSelection?: [number, number];

  /**
   * The text to display underneath the input box.
   */
  prompt?: string;

  /**
   * An optional string to show as placeholder in the input box to guide the user what to type.
   */
  placeHolder?: string;

  /**
   * Controls if a password input is shown. Password input hides the typed text.
   */
  password?: boolean;

  /**
   * Set to `true` to keep the input box open when focus moves to another part of the editor or to another window.
   * This setting is ignored on iPad and is always false.
   */
  ignoreFocusOut?: boolean;

  /**
   * An optional function that will be called to validate input and to give a hint
   * to the user.
   *
   * @param value The current value of the input box.
   * @returns Either a human-readable string which is presented as an error message or an {@link InputBoxValidationMessage}
   *  which can provide a specific message severity. Return `undefined`, `null`, or the empty string when 'value' is valid.
   */
  validateInput?(
    value: string,
  ): string | InputBoxValidationMessage | undefined | null | Promise<string | InputBoxValidationMessage | undefined | null>;
}

/**
 * Opens an input box to ask the user for input.
 *
 * The returned value will be `undefined` if the input box was canceled (e.g. pressing ESC). Otherwise the
 * returned value will be the string typed by the user or an empty string if the user did not type
 * anything but dismissed the input box with OK.
 *
 * @param options Configures the behavior of the input box.
 * @param token A token that can be used to signal cancellation.
 * @returns A promise that resolves to a string the user provided or to `undefined` in case of dismissal.
 */
export function showInputBox(options?: InputBoxOptions, token?: CancellationToken): Promise<string | undefined>;

/**
 * The kind of {@link QuickPickItem quick pick item}.
 */
export enum QuickPickItemKind {
  /**
   * When a {@link QuickPickItem} has a kind of {@link Separator}, the item is just a visual separator and does not represent a real item.
   * The only property that applies is {@link QuickPickItem.label label }. All other properties on {@link QuickPickItem} will be ignored and have no effect.
   */
  Separator = -1,
  /**
   * The default {@link QuickPickItem.kind} is an item that can be selected in the quick pick.
   */
  Default = 0,
}

/**
 * Represents an item that can be selected from
 * a list of items.
 */
export interface QuickPickItem {
  /**
   * A human-readable string which is rendered prominent. Supports rendering of {@link ThemeIcon theme icons} via
   * the `$(<name>)`-syntax.
   */
  label: string;

  /**
   * The kind of QuickPickItem that will determine how this item is rendered in the quick pick. When not specified,
   * the default is {@link QuickPickItemKind.Default}.
   */
  kind?: QuickPickItemKind;

  /**
   * The icon path or {@link ThemeIcon} for the QuickPickItem.
   */
  // iconPath?: Uri | {
  //   /**
  //    * The icon path for the light theme.
  //    */
  //   light: Uri;
  //   /**
  //    * The icon path for the dark theme.
  //    */
  //   dark: Uri;
  // } | ThemeIcon;

  /**
   * A human-readable string which is rendered less prominent in the same line. Supports rendering of
   * {@link ThemeIcon theme icons} via the `$(<name>)`-syntax.
   *
   * Note: this property is ignored when {@link QuickPickItem.kind kind} is set to {@link QuickPickItemKind.Separator}
   */
  description?: string;

  /**
   * A human-readable string which is rendered less prominent in a separate line. Supports rendering of
   * {@link ThemeIcon theme icons} via the `$(<name>)`-syntax.
   *
   * Note: this property is ignored when {@link QuickPickItem.kind kind} is set to {@link QuickPickItemKind.Separator}
   */
  detail?: string;

  /**
   * Optional flag indicating if this item is picked initially. This is only honored when using
   * the {@link window.showQuickPick showQuickPick()} API. To do the same thing with
   * the {@link window.createQuickPick createQuickPick()} API, simply set the {@link QuickPick.selectedItems}
   * to the items you want picked initially.
   * (*Note:* This is only honored when the picker allows multiple selections.)
   *
   * @see {@link QuickPickOptions.canPickMany}
   *
   * Note: this property is ignored when {@link QuickPickItem.kind kind} is set to {@link QuickPickItemKind.Separator}
   */
  picked?: boolean;

  /**
   * Always show this item.
   *
   * Note: this property is ignored when {@link QuickPickItem.kind kind} is set to {@link QuickPickItemKind.Separator}
   */
  alwaysShow?: boolean;

  /**
   * Optional buttons that will be rendered on this particular item. These buttons will trigger
   * an {@link QuickPickItemButtonEvent} when clicked. Buttons are only rendered when using a quickpick
   * created by the {@link window.createQuickPick createQuickPick()} API. Buttons are not rendered when using
   * the {@link window.showQuickPick showQuickPick()} API.
   *
   * Note: this property is ignored when {@link QuickPickItem.kind kind} is set to {@link QuickPickItemKind.Separator}
   */
  //  buttons?: readonly QuickInputButton[];
}

/**
 * Options to configure the behavior of the quick pick UI.
 */
export interface QuickPickOptions {
  /**
   * An optional string that represents the title of the quick pick.
   */
  title?: string;

  /**
   * An optional flag to include the description when filtering the picks.
   */
  matchOnDescription?: boolean;

  /**
   * An optional flag to include the detail when filtering the picks.
   */
  matchOnDetail?: boolean;

  /**
   * An optional string to show as placeholder in the input box to guide the user what to pick on.
   */
  placeHolder?: string;

  /**
   * Set to `true` to keep the picker open when focus moves to another part of the editor or to another window.
   * This setting is ignored on iPad and is always false.
   */
  ignoreFocusOut?: boolean;

  /**
   * An optional flag to make the picker accept multiple selections, if true the result is an array of picks.
   */
  canPickMany?: boolean;

  /**
   * An optional function that is invoked whenever an item is selected.
   */
  onDidSelectItem?(item: QuickPickItem | string): any;
}

/**
 * Shows a selection list allowing multiple selections.
 *
 * @param items An array of strings, or a promise that resolves to an array of strings.
 * @param options Configures the behavior of the selection list.
 * @param token A token that can be used to signal cancellation.
 * @returns A promise that resolves to the selected items or `undefined`.
 */
export function showQuickPick(
  items: readonly string[] | Promise<readonly string[]>,
  options: QuickPickOptions & { /** literal-type defines return type */ canPickMany: true },
  token?: CancellationToken,
): Promise<string[] | undefined>;

/**
 * Shows a selection list.
 *
 * @param items An array of strings, or a promise that resolves to an array of strings.
 * @param options Configures the behavior of the selection list.
 * @param token A token that can be used to signal cancellation.
 * @returns A promise that resolves to the selection or `undefined`.
 */
export function showQuickPick(
  items: readonly string[] | Promise<readonly string[]>,
  options?: QuickPickOptions,
  token?: CancellationToken,
): Promise<string | undefined>;

/**
 * Shows a selection list allowing multiple selections.
 *
 * @param items An array of items, or a promise that resolves to an array of items.
 * @param options Configures the behavior of the selection list.
 * @param token A token that can be used to signal cancellation.
 * @returns A promise that resolves to the selected items or `undefined`.
 */
export function showQuickPick<T extends QuickPickItem>(
  items: readonly T[] | Promise<readonly T[]>,
  options: QuickPickOptions & { /** literal-type defines return type */ canPickMany: true },
  token?: CancellationToken,
): Promise<T[] | undefined>;

/**
 * Shows a selection list.
 *
 * @param items An array of items, or a promise that resolves to an array of items.
 * @param options Configures the behavior of the selection list.
 * @param token A token that can be used to signal cancellation.
 * @returns A promise that resolves to the selected item or `undefined`.
 */
export function showQuickPick<T extends QuickPickItem>(
  items: readonly T[] | Promise<readonly T[]>,
  options?: QuickPickOptions,
  token?: CancellationToken,
): Promise<T | undefined>;
