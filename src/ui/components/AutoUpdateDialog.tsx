import { Button, Checkbox, Label, Modal } from '@heroui/react';
import { useState } from 'react';
import { usePrefs } from '../usePrefs.ts';

// Asks before auto update goes on. Cancelling changes nothing, also not the checkbox.
export function AutoUpdateDialog({ always, onConfirm, onClose }: { always: boolean; onConfirm: (hideNextTime: boolean) => void; onClose: () => void }) {
  const { t } = usePrefs();
  const [hide, setHide] = useState(false);
  return (
    <Modal.Backdrop isOpen onOpenChange={(o) => !o && onClose()}>
      <Modal.Container>
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>{always ? t.autoDialogTitleAlways : t.autoDialogTitle}</Modal.Heading>
          </Modal.Header>
          <Modal.Body className="flex flex-col gap-3 text-sm leading-relaxed">
            <p className="m-0 text-warning">{t.autoDialogText}</p>
            {always && <p className="m-0 text-warning">{t.autoDialogAlways}</p>}
            <div>
              <p className="m-0 font-semibold">{t.autoDialogKept}</p>
              <ul className="m-0 mt-1 list-disc pl-5">
                {t.autoDialogKeptList.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <Checkbox variant="secondary" isSelected={hide} onChange={setHide}>
              <Checkbox.Content>
                <Checkbox.Control>
                  <Checkbox.Indicator />
                </Checkbox.Control>
                <Label>{t.autoDialogHide}</Label>
              </Checkbox.Content>
            </Checkbox>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="tertiary" onPress={onClose}>
              {t.cancel}
            </Button>
            <Button variant="primary" onPress={() => onConfirm(hide)}>
              {t.autoDialogConfirm}
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
