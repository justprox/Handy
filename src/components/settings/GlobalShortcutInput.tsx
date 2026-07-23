import React, { useEffect, useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  getKeyName,
  formatKeyCombination,
  normalizeKey,
} from "../../lib/utils/keyboard";
import { ResetButton } from "../ui/ResetButton";
import { SettingContainer } from "../ui/SettingContainer";
import { useSettings } from "../../hooks/useSettings";
import { useOsType } from "../../hooks/useOsType";
import { commands } from "@/bindings";
import { toast } from "sonner";

interface GlobalShortcutInputProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
  shortcutId: string;
  disabled?: boolean;
}

export const GlobalShortcutInput: React.FC<GlobalShortcutInputProps> = ({
  descriptionMode = "tooltip",
  grouped = false,
  shortcutId,
  disabled = false,
}) => {
  const { t } = useTranslation();
  const { getSetting, updateBinding, resetBinding, isUpdating, isLoading } =
    useSettings();
  const [keyPressed, setKeyPressed] = useState<string[]>([]);
  const [recordedKeys, setRecordedKeys] = useState<string[]>([]);
  const [recordingIndex, setRecordingIndex] = useState<number | "add" | null>(null);
  const [originalBinding, setOriginalBinding] = useState<string>("");
  const shortcutRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const osType = useOsType();

  const bindings = getSetting("bindings") || {};
  const binding = bindings[shortcutId];
  const shortcuts = (binding?.current_binding || "")
    .split(", ")
    .map((s) => s.trim())
    .filter(Boolean);

  const isRecording = recordingIndex !== null;

  useEffect(() => {
    // Only add event listeners when we're in editing mode
    if (recordingIndex === null) return;

    let cleanup = false;

    // Keyboard event listeners
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (cleanup) return;
      if (e.repeat) return; // ignore auto-repeat
      e.preventDefault();

      // Get the key with OS-specific naming and normalize it
      const rawKey = getKeyName(e, osType);
      const key = normalizeKey(rawKey);

      if (!keyPressed.includes(key)) {
        setKeyPressed((prev) => [...prev, key]);
        // Also add to recorded keys if not already there
        if (!recordedKeys.includes(key)) {
          setRecordedKeys((prev) => [...prev, key]);
        }
      }
    };

    const handleKeyUp = async (e: KeyboardEvent) => {
      if (cleanup) return;
      e.preventDefault();

      // Get the key with OS-specific naming and normalize it
      const rawKey = getKeyName(e, osType);
      const key = normalizeKey(rawKey);

      // Remove from currently pressed keys
      setKeyPressed((prev) => prev.filter((k) => k !== key));

      // If no keys are pressed anymore, commit the shortcut
      const updatedKeyPressed = keyPressed.filter((k) => k !== key);
      if (updatedKeyPressed.length === 0 && recordedKeys.length > 0) {
        // Create the shortcut string from all recorded keys
        // Sort keys so modifiers come first, then the main key
        const modifiers = [
          "ctrl",
          "control",
          "shift",
          "alt",
          "option",
          "meta",
          "command",
          "cmd",
          "super",
          "win",
          "windows",
        ];
        const sortedKeys = recordedKeys.sort((a, b) => {
          const aIsModifier = modifiers.includes(a.toLowerCase());
          const bIsModifier = modifiers.includes(b.toLowerCase());
          if (aIsModifier && !bIsModifier) return -1;
          if (!aIsModifier && bIsModifier) return 1;
          return 0;
        });
        const newShortcut = sortedKeys.join("+");
        let newBindingValue = "";

        if (recordingIndex === "add") {
          newBindingValue = [...shortcuts, newShortcut].join(", ");
        } else {
          const updated = [...shortcuts];
          updated[recordingIndex] = newShortcut;
          newBindingValue = updated.join(", ");
        }

        if (binding) {
          try {
            await updateBinding(shortcutId, newBindingValue);
          } catch (error) {
            console.error("Failed to change binding:", error);
            toast.error(
              t("settings.general.shortcut.errors.set", {
                error: String(error),
              }),
            );

            // Reset to original binding on error
            if (originalBinding) {
              try {
                await updateBinding(shortcutId, originalBinding);
              } catch (resetError) {
                console.error("Failed to reset binding:", resetError);
                toast.error(t("settings.general.shortcut.errors.reset"));
              }
            }
          }

          // Exit editing mode and reset states
          setRecordingIndex(null);
          setKeyPressed([]);
          setRecordedKeys([]);
          setOriginalBinding("");
        }
      }
    };

    // Add click outside handler
    const handleClickOutside = async (e: MouseEvent) => {
      if (cleanup) return;
      const refKey = `${shortcutId}_${recordingIndex}`;
      const activeElement = shortcutRefs.current.get(refKey);
      if (activeElement && !activeElement.contains(e.target as Node)) {
        // Cancel shortcut recording and restore original binding
        if (originalBinding) {
          try {
            await updateBinding(shortcutId, originalBinding);
          } catch (error) {
            console.error("Failed to restore original binding:", error);
            toast.error(t("settings.general.shortcut.errors.restore"));
          }
        } else {
          commands.resumeBinding(shortcutId).catch(console.error);
        }
        setRecordingIndex(null);
        setKeyPressed([]);
        setRecordedKeys([]);
        setOriginalBinding("");
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("click", handleClickOutside);

    return () => {
      cleanup = true;
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("click", handleClickOutside);
    };
  }, [
    keyPressed,
    recordedKeys,
    recordingIndex,
    shortcuts,
    binding,
    originalBinding,
    updateBinding,
    osType,
    shortcutId,
    t,
  ]);

  // Start recording a new shortcut or editing one
  const startRecording = async (index: number | "add") => {
    if (recordingIndex !== null) return; // Already editing

    // Suspend current binding to avoid firing while recording
    await commands.suspendBinding(shortcutId).catch(console.error);

    // Store the original binding to restore if canceled
    setOriginalBinding(binding?.current_binding || "");
    setRecordingIndex(index);
    setKeyPressed([]);
    setRecordedKeys([]);
  };

  // Remove a shortcut from the list
  const removeShortcut = async (indexToRemove: number) => {
    if (shortcuts.length <= 1) {
      toast.warning(t("settings.general.shortcut.errors.keepAtLeastOne", "At least one shortcut must be configured."));
      return;
    }
    const updated = shortcuts.filter((_, idx) => idx !== indexToRemove);
    const newBindingValue = updated.join(", ");
    try {
      await updateBinding(shortcutId, newBindingValue);
      toast.success(t("settings.general.shortcut.removed", "Shortcut removed"));
    } catch (error) {
      console.error("Failed to remove shortcut:", error);
      toast.error(t("settings.general.shortcut.errors.remove", "Failed to remove shortcut"));
    }
  };

  // Format the current shortcut keys being recorded
  const formatCurrentKeys = (): string => {
    if (recordedKeys.length === 0)
      return t("settings.general.shortcut.pressKeys");

    // Use the same formatting as the display to ensure consistency
    return formatKeyCombination(recordedKeys.join("+"), osType);
  };

  // Store references to shortcut elements
  const setShortcutRef = (index: number | "add", ref: HTMLDivElement | null) => {
    shortcutRefs.current.set(`${shortcutId}_${index}`, ref);
  };

  // If still loading, show loading state
  if (isLoading) {
    return (
      <SettingContainer
        title={t("settings.general.shortcut.title")}
        description={t("settings.general.shortcut.description")}
        descriptionMode={descriptionMode}
        grouped={grouped}
      >
        <div className="text-sm text-mid-gray">
          {t("settings.general.shortcut.loading")}
        </div>
      </SettingContainer>
    );
  }

  // If no bindings are loaded, show empty state
  if (Object.keys(bindings).length === 0) {
    return (
      <SettingContainer
        title={t("settings.general.shortcut.title")}
        description={t("settings.general.shortcut.description")}
        descriptionMode={descriptionMode}
        grouped={grouped}
      >
        <div className="text-sm text-mid-gray">
          {t("settings.general.shortcut.none")}
        </div>
      </SettingContainer>
    );
  }

  if (!binding) {
    return (
      <SettingContainer
        title={t("settings.general.shortcut.title")}
        description={t("settings.general.shortcut.notFound")}
        descriptionMode={descriptionMode}
        grouped={grouped}
      >
        <div className="text-sm text-mid-gray">
          {t("settings.general.shortcut.none")}
        </div>
      </SettingContainer>
    );
  }

  // Get translated name and description for the binding
  const translatedName = t(
    `settings.general.shortcut.bindings.${shortcutId}.name`,
    binding.name,
  );
  const translatedDescription = t(
    `settings.general.shortcut.bindings.${shortcutId}.description`,
    binding.description,
  );

  return (
    <SettingContainer
      title={translatedName}
      description={translatedDescription}
      descriptionMode={descriptionMode}
      grouped={grouped}
      disabled={disabled}
      layout="horizontal"
    >
      <div className="flex flex-col space-y-2 w-full max-w-md items-end">
        <div className="flex flex-wrap gap-2 justify-end items-center">
          {shortcuts.map((sc, index) => {
            const isThisRecording = recordingIndex === index;
            return (
              <div key={index} className="flex items-center space-x-1">
                {isThisRecording ? (
                  <div
                    ref={(ref) => setShortcutRef(index, ref)}
                    className="px-2 py-1 text-sm font-semibold border border-logo-primary bg-logo-primary/30 rounded-md"
                  >
                    {formatCurrentKeys()}
                  </div>
                ) : (
                  <div className="flex items-center bg-mid-gray/10 border border-mid-gray/80 hover:border-logo-primary hover:bg-logo-primary/5 rounded-md overflow-hidden">
                    <span
                      className="px-2 py-1 text-sm font-semibold cursor-pointer select-none"
                      onClick={() => startRecording(index)}
                      title={t("settings.general.shortcut.clickToEdit", "Click to edit")}
                    >
                      {formatKeyCombination(sc, osType)}
                    </span>
                    {shortcuts.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeShortcut(index)}
                        className="px-1.5 py-1 text-xs hover:text-red-500 text-text/50 border-l border-mid-gray/40 hover:bg-red-500/10 cursor-pointer"
                        title={t("settings.general.shortcut.remove", "Remove")}
                      >
                        {t("settings.general.shortcut.removeSymbol", "✕")}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {recordingIndex === "add" ? (
            <div
              ref={(ref) => setShortcutRef("add", ref)}
              className="px-2 py-1 text-sm font-semibold border border-logo-primary bg-logo-primary/30 rounded-md"
            >
              {formatCurrentKeys()}
            </div>
          ) : (
            recordingIndex === null && shortcuts.length < 3 && (
              <button
                type="button"
                onClick={() => startRecording("add")}
                className="px-2 py-1 text-sm font-semibold border border-dashed border-logo-primary/60 text-logo-primary hover:border-logo-primary hover:bg-logo-primary/10 rounded-md cursor-pointer transition-all"
              >
                + {t("settings.general.shortcut.addButton", "Add Shortcut")}
              </button>
            )
          )}

          <ResetButton
            onClick={() => resetBinding(shortcutId)}
            disabled={isUpdating(`binding_${shortcutId}`) || recordingIndex !== null}
          />
        </div>
      </div>
    </SettingContainer>
  );
};
