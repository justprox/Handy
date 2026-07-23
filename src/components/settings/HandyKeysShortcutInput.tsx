import React, { useEffect, useState, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { formatKeyCombination } from "../../lib/utils/keyboard";
import { ResetButton } from "../ui/ResetButton";
import { SettingContainer } from "../ui/SettingContainer";
import { useSettings } from "../../hooks/useSettings";
import { useOsType } from "../../hooks/useOsType";
import { commands } from "@/bindings";
import { toast } from "sonner";

interface HandyKeysShortcutInputProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
  shortcutId: string;
  disabled?: boolean;
}

interface HandyKeysEvent {
  modifiers: string[];
  key: string | null;
  is_key_down: boolean;
  hotkey_string: string;
}

export const HandyKeysShortcutInput: React.FC<HandyKeysShortcutInputProps> = ({
  descriptionMode = "tooltip",
  grouped = false,
  shortcutId,
  disabled = false,
}) => {
  const { t } = useTranslation();
  const { getSetting, updateBinding, resetBinding, isUpdating, isLoading } =
    useSettings();
  const [recordingIndex, setRecordingIndex] = useState<number | "add" | null>(null);
  const [currentKeys, setCurrentKeys] = useState<string>("");
  const [originalBinding, setOriginalBinding] = useState<string>("");
  const shortcutRef = useRef<HTMLDivElement | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);
  // Use a ref to track currentKeys for the event handler (avoids stale closure)
  const currentKeysRef = useRef<string>("");
  const osType = useOsType();

  const bindings = getSetting("bindings") || {};
  const binding = bindings[shortcutId];
  const shortcuts = (binding?.current_binding || "")
    .split(", ")
    .map((s) => s.trim())
    .filter(Boolean);

  const isRecording = recordingIndex !== null;

  // Handle cancellation
  const cancelRecording = useCallback(async () => {
    if (recordingIndex === null) return;

    // Stop listening for backend events
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }

    // Stop backend recording
    await commands.stopHandyKeysRecording().catch(console.error);

    // Restore original binding
    if (originalBinding) {
      try {
        await updateBinding(shortcutId, originalBinding);
      } catch (error) {
        console.error("Failed to restore original binding:", error);
        toast.error(t("settings.general.shortcut.errors.restore"));
      }
    }

    setRecordingIndex(null);
    setCurrentKeys("");
    currentKeysRef.current = "";
    setOriginalBinding("");
  }, [recordingIndex, originalBinding, shortcutId, updateBinding, t]);

  // Set up event listener for handy-keys events
  useEffect(() => {
    if (recordingIndex === null) return;

    let cleanup = false;

    const setupListener = async () => {
      // Listen for key events from backend
      const unlisten = await listen<HandyKeysEvent>(
        "handy-keys-event",
        async (event) => {
          if (cleanup) return;

          const { hotkey_string, is_key_down } = event.payload;

          if (is_key_down && hotkey_string) {
            // Update both state (for display) and ref (for release handler)
            currentKeysRef.current = hotkey_string;
            setCurrentKeys(hotkey_string);
          } else if (!is_key_down && currentKeysRef.current) {
            // Key released - commit the shortcut using the ref value
            const keysToCommit = currentKeysRef.current;
            let newBindingValue = "";

            if (recordingIndex === "add") {
              newBindingValue = [...shortcuts, keysToCommit].join(", ");
            } else {
              const updated = [...shortcuts];
              updated[recordingIndex] = keysToCommit;
              newBindingValue = updated.join(", ");
            }

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

            // Stop recording
            if (unlistenRef.current) {
              unlistenRef.current();
              unlistenRef.current = null;
            }
            await commands.stopHandyKeysRecording().catch(console.error);
            setRecordingIndex(null);
            setCurrentKeys("");
            currentKeysRef.current = "";
            setOriginalBinding("");
          }
        },
      );

      unlistenRef.current = unlisten;
    };

    setupListener();

    return () => {
      cleanup = true;
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
      // Stop backend recording on unmount to prevent orphaned recording loops
      commands.stopHandyKeysRecording().catch(console.error);
    };
  }, [
    recordingIndex,
    shortcutId,
    originalBinding,
    updateBinding,
    shortcuts,
    t,
  ]);

  // Handle click outside
  useEffect(() => {
    if (recordingIndex === null) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        shortcutRef.current &&
        !shortcutRef.current.contains(e.target as Node)
      ) {
        cancelRecording();
      }
    };

    window.addEventListener("click", handleClickOutside);
    return () => window.removeEventListener("click", handleClickOutside);
  }, [recordingIndex, cancelRecording]);

  // Start recording a new shortcut or editing one
  const startRecording = async (index: number | "add") => {
    if (recordingIndex !== null) return;

    // Store the original binding to restore if canceled
    setOriginalBinding(binding?.current_binding || "");

    // Start backend recording
    try {
      await commands.startHandyKeysRecording(shortcutId);
      setRecordingIndex(index);
      setCurrentKeys("");
      currentKeysRef.current = "";
    } catch (error) {
      console.error("Failed to start recording:", error);
      toast.error(
        t("settings.general.shortcut.errors.set", { error: String(error) }),
      );
    }
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
    if (!currentKeys) return t("settings.general.shortcut.pressKeys");
    return formatKeyCombination(currentKeys, osType);
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
                    ref={shortcutRef}
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
              ref={shortcutRef}
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
