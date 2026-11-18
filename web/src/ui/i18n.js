// The page's words, in the app's three languages (the browser's, unless she picks one in Ajustes).
const S = {
  pt: {
    write: 'Escrever', today: 'Hoje', tasks: 'Tarefas', notes: 'Notas', diary: 'Diário', meds: 'Remédios', gallery: 'Galeria', search: 'Buscar', settings: 'Ajustes',
    invite: 'O que está na sua cabeça?', send: 'Guardar', sendHint: 'Ctrl + Enter guarda', attachPhoto: 'Pôr fotos', attachFile: 'Pôr arquivos', dropHere: 'Solte aqui pra pôr junto',
    line_going: 'Organizando…', line_in_line: 'Na fila', line_later: 'Sem internet · vai sozinho quando voltar', line_phone: 'O celular organiza', line_failed: 'Não foi', retry: 'Tentar de novo', discard: 'Descartar', stop: 'Parar',
    late: 'Atrasadas', for_today: 'Pra hoje', through_day: 'Ao longo do dia', doing: 'Em andamento', done_today: 'Feitas hoje', done: 'Feitas', noCategory: 'Sem categoria', all: 'Todas',
    dayToday: 'Hoje', dayYesterday: 'Ontem', emptyToday: 'Nada pra hoje.', emptyTasks: 'Nenhuma tarefa.', emptyNotes: 'Nenhuma nota ainda.', emptyDiary: 'O diário começa quando você conta o dia.', emptyMeds: 'Nenhum remédio.', emptyGallery: 'As fotos aparecem aqui.', emptySearch: 'Nada achado.',
    kind_task: 'Tarefa', kind_note: 'Nota', kind_diary: 'Diário', st_todo: 'A fazer', st_doing: 'Em andamento', st_waiting: 'Esperando', st_done: 'Feito',
    title: 'Título', body: 'Escreva aqui…', steps: 'Etapas', newStep: 'Nova etapa', due: 'Prazo', reminder: 'Lembrete', noReminder: 'Sem lembrete', repeat: 'Repete', once: 'Uma vez', daily: 'Todo dia', weekly: 'Toda semana', monthly: 'Todo mês',
    alarm: 'Tocar como alarme', sensitive: 'Esconder (senha, documento)', show: 'Mostrar', delete: 'Apagar', deleted: 'Apagado', undo: 'Desfazer', category: 'Categoria', chooseCategory: 'Escolher categoria', newCategory: 'Nova categoria…', close: 'Fechar',
    outcome_created: 'Novo', outcome_updated: 'Mudou', outcome_done: 'Feito', saidLabel: 'o que você escreveu', newTask: 'Nova tarefa', newNote: 'Nova nota', newDiary: 'Escrever no diário',
    med_when: 'Quando precisar', med_until: 'até', med_daysLeft: '{n} dias', med_person: 'pra {p}', med_taken: 'tomado', newMed: 'Novo remédio', medName: 'Nome', medDose: 'Dose', medStrength: 'Força', medTimes: 'Horários (08:00, 20:00)', medEnd: 'Até', medNotes: 'Como tomar',
    photo: 'Foto', photoOnPhone: 'A foto ainda está no celular', turn: 'Girar', remove: 'Remover', file: 'Arquivo', open: 'Abrir', download: 'Baixar',
    syncOk: 'Em dia', syncBusy: 'Sincronizando…', syncOff: 'Sem conexão', syncErr: 'Não deu pra sincronizar',
    theme: 'Tema', themeSystem: 'Do sistema', themeLight: 'Claro', themeDark: 'Escuro', accent: 'Cor', language: 'Idioma', linkedTo: 'Ligado ao {p}', unlink: 'Desligar este computador', unlinkSure: 'Clique de novo pra desligar',
    unlinkHint: 'O que está neste navegador é apagado. No celular nada muda.',
    linkTitle: 'O Novelo no computador', linkLead: 'Pra escrever com calma. Tudo junto com o celular.', link1: 'Abra o Novelo no celular', link2: 'Ajustes › Computador › Ligar um computador', link3: 'Aponte o celular pra este código',
    linkSafe: 'O celular manda a chave direto pra este computador, cifrada. O servidor não consegue ler nada do que você guarda.', linkExpired: 'O código expirou.', linkNew: 'Mostrar outro', linkWaiting: 'Esperando o celular…', linking: 'Abrindo…', linkFailed: 'Não deu pra ligar. Tente de novo.',
    unlinked: 'Este computador foi desligado do celular.',
    keepLinked: 'Manter ligado neste computador', keepLinkedHint: 'Desmarque num computador de outra pessoa: nada fica guardado nele, e ele se desliga quando você fecha a aba.',
    sharedBadge: 'Nada fica guardado aqui · fechar a aba desliga', mic: 'Falar', micStop: 'Parar e escrever', micCancel: 'Descartar a gravação', micHearing: 'Transcrevendo…', micDenied: 'Sem acesso ao microfone. Libere no cadeado da barra de endereço.', micNone: 'Nenhum microfone encontrado.', micNothing: 'Não ouvi nada.', micFailed: 'Não deu pra transcrever agora.', micOffline: 'Sem internet pra transcrever agora.', install: 'Instalar como aplicativo', installHint: 'Abre numa janela própria, como um programa do computador.', otherTab: 'O Novelo está aberto em outra aba', otherTabHint: 'Ele trabalha numa aba de cada vez, pra nada ser organizado duas vezes.', useHere: 'Usar aqui',
    mobileTitle: 'No celular, o Novelo é o app', mobileLead: 'Fale, e ele organiza. A versão do navegador é pro computador.', mobileGet: 'Baixar o Novelo pra Android', mobileLink: 'Pra ligar o computador: Novelo › Ajustes › Computador.',
    searchHint: 'Buscar no que você guardou', photos: 'Fotos', files: 'Arquivos', sound: 'Áudio', willAsk: 'O Novelo vai perguntar como está {d}.', topics: 'Assuntos',
    next: 'próximo', now: 'agora', tomorrow: 'amanhã', yesterday: 'ontem', linkOn: 'no',
  },
  es: {
    write: 'Escribir', today: 'Hoy', tasks: 'Tareas', notes: 'Notas', diary: 'Diario', meds: 'Remedios', gallery: 'Galería', search: 'Buscar', settings: 'Ajustes',
    invite: '¿Qué tienes en la cabeza?', send: 'Guardar', sendHint: 'Ctrl + Enter guarda', attachPhoto: 'Poner fotos', attachFile: 'Poner archivos', dropHere: 'Suelta aquí para ponerlo junto',
    line_going: 'Organizando…', line_in_line: 'En la fila', line_later: 'Sin internet · se va solo cuando vuelva', line_phone: 'El celular lo organiza', line_failed: 'No se pudo', retry: 'Intentar de nuevo', discard: 'Descartar', stop: 'Parar',
    late: 'Atrasadas', for_today: 'Para hoy', through_day: 'A lo largo del día', doing: 'En curso', done_today: 'Hechas hoy', done: 'Hechas', noCategory: 'Sin categoría', all: 'Todas',
    dayToday: 'Hoy', dayYesterday: 'Ayer', emptyToday: 'Nada para hoy.', emptyTasks: 'Ninguna tarea.', emptyNotes: 'Ninguna nota todavía.', emptyDiary: 'El diario empieza cuando cuentas el día.', emptyMeds: 'Ningún remedio.', emptyGallery: 'Las fotos aparecen aquí.', emptySearch: 'No se encontró nada.',
    kind_task: 'Tarea', kind_note: 'Nota', kind_diary: 'Diario', st_todo: 'Por hacer', st_doing: 'En curso', st_waiting: 'Esperando', st_done: 'Hecho',
    title: 'Título', body: 'Escribe aquí…', steps: 'Pasos', newStep: 'Nuevo paso', due: 'Plazo', reminder: 'Recordatorio', noReminder: 'Sin recordatorio', repeat: 'Repite', once: 'Una vez', daily: 'Todos los días', weekly: 'Cada semana', monthly: 'Cada mes',
    alarm: 'Sonar como alarma', sensitive: 'Ocultar (contraseña, documento)', show: 'Mostrar', delete: 'Borrar', deleted: 'Borrado', undo: 'Deshacer', category: 'Categoría', chooseCategory: 'Elegir categoría', newCategory: 'Nueva categoría…', close: 'Cerrar',
    outcome_created: 'Nuevo', outcome_updated: 'Cambió', outcome_done: 'Hecho', saidLabel: 'lo que escribiste', newTask: 'Nueva tarea', newNote: 'Nueva nota', newDiary: 'Escribir en el diario',
    med_when: 'Cuando lo necesite', med_until: 'hasta', med_daysLeft: '{n} días', med_person: 'para {p}', med_taken: 'tomado', newMed: 'Nuevo remedio', medName: 'Nombre', medDose: 'Dosis', medStrength: 'Concentración', medTimes: 'Horarios (08:00, 20:00)', medEnd: 'Hasta', medNotes: 'Cómo tomarlo',
    photo: 'Foto', photoOnPhone: 'La foto todavía está en el celular', turn: 'Girar', remove: 'Quitar', file: 'Archivo', open: 'Abrir', download: 'Descargar',
    syncOk: 'Al día', syncBusy: 'Sincronizando…', syncOff: 'Sin conexión', syncErr: 'No se pudo sincronizar',
    theme: 'Tema', themeSystem: 'Del sistema', themeLight: 'Claro', themeDark: 'Oscuro', accent: 'Color', language: 'Idioma', linkedTo: 'Conectado a {p}', unlink: 'Desconectar esta computadora', unlinkSure: 'Haz clic de nuevo para desconectar',
    unlinkHint: 'Lo que está en este navegador se borra. En el celular no cambia nada.',
    linkTitle: 'El Novelo en la computadora', linkLead: 'Para escribir con calma. Todo junto con el celular.', link1: 'Abre el Novelo en el celular', link2: 'Ajustes › Computadora › Conectar una computadora', link3: 'Apunta el celular a este código',
    linkSafe: 'El celular manda la clave directo a esta computadora, cifrada. El servidor no puede leer nada de lo que guardas.', linkExpired: 'El código venció.', linkNew: 'Mostrar otro', linkWaiting: 'Esperando el celular…', linking: 'Abriendo…', linkFailed: 'No se pudo conectar. Inténtalo de nuevo.',
    unlinked: 'Esta computadora se desconectó del celular.',
    keepLinked: 'Mantener conectada esta computadora', keepLinkedHint: 'Desmárcalo en una computadora de otra persona: no se guarda nada en ella, y se desconecta al cerrar la pestaña.',
    sharedBadge: 'No se guarda nada aquí · cerrar la pestaña desconecta', mic: 'Hablar', micStop: 'Parar y escribir', micCancel: 'Descartar la grabación', micHearing: 'Transcribiendo…', micDenied: 'Sin acceso al micrófono. Permítelo en el candado de la barra de direcciones.', micNone: 'No se encontró ningún micrófono.', micNothing: 'No escuché nada.', micFailed: 'No se pudo transcribir ahora.', micOffline: 'Sin internet para transcribir ahora.', install: 'Instalar como aplicación', installHint: 'Se abre en su propia ventana, como un programa de la computadora.', otherTab: 'El Novelo está abierto en otra pestaña', otherTabHint: 'Trabaja en una pestaña a la vez, para que nada se organice dos veces.', useHere: 'Usar aquí',
    mobileTitle: 'En el celular, el Novelo es la app', mobileLead: 'Habla, y él organiza. La versión del navegador es para la computadora.', mobileGet: 'Descargar el Novelo para Android', mobileLink: 'Para conectar la computadora: Novelo › Ajustes › Computadora.',
    searchHint: 'Buscar en lo que guardaste', photos: 'Fotos', files: 'Archivos', sound: 'Audio', willAsk: 'El Novelo va a preguntar cómo va {d}.', topics: 'Temas',
    next: 'próximo', now: 'ahora', tomorrow: 'mañana', yesterday: 'ayer', linkOn: 'en',
  },
  en: {
    write: 'Write', today: 'Today', tasks: 'Tasks', notes: 'Notes', diary: 'Diary', meds: 'Medicines', gallery: 'Gallery', search: 'Search', settings: 'Settings',
    invite: "What's on your mind?", send: 'Keep', sendHint: 'Ctrl + Enter keeps it', attachPhoto: 'Add photos', attachFile: 'Add files', dropHere: 'Drop here to add',
    line_going: 'Organizing…', line_in_line: 'In line', line_later: "No internet · it goes when it's back", line_phone: 'The phone organizes it', line_failed: "It didn't go", retry: 'Try again', discard: 'Discard', stop: 'Stop',
    late: 'Late', for_today: 'For today', through_day: 'During the day', doing: 'In progress', done_today: 'Done today', done: 'Done', noCategory: 'No category', all: 'All',
    dayToday: 'Today', dayYesterday: 'Yesterday', emptyToday: 'Nothing for today.', emptyTasks: 'No tasks.', emptyNotes: 'No notes yet.', emptyDiary: 'The diary starts when you tell your day.', emptyMeds: 'No medicines.', emptyGallery: 'Photos show up here.', emptySearch: 'Nothing found.',
    kind_task: 'Task', kind_note: 'Note', kind_diary: 'Diary', st_todo: 'To do', st_doing: 'In progress', st_waiting: 'Waiting', st_done: 'Done',
    title: 'Title', body: 'Write here…', steps: 'Steps', newStep: 'New step', due: 'Due', reminder: 'Reminder', noReminder: 'No reminder', repeat: 'Repeats', once: 'Once', daily: 'Every day', weekly: 'Every week', monthly: 'Every month',
    alarm: 'Ring as an alarm', sensitive: 'Hide (password, document)', show: 'Show', delete: 'Delete', deleted: 'Deleted', undo: 'Undo', category: 'Category', chooseCategory: 'Choose category', newCategory: 'New category…', close: 'Close',
    outcome_created: 'New', outcome_updated: 'Changed', outcome_done: 'Done', saidLabel: 'what you wrote', newTask: 'New task', newNote: 'New note', newDiary: 'Write in the diary',
    med_when: 'When needed', med_until: 'until', med_daysLeft: '{n} days', med_person: 'for {p}', med_taken: 'taken', newMed: 'New medicine', medName: 'Name', medDose: 'Dose', medStrength: 'Strength', medTimes: 'Times (08:00, 20:00)', medEnd: 'Until', medNotes: 'How to take it',
    photo: 'Photo', photoOnPhone: 'The photo is still on the phone', turn: 'Turn', remove: 'Remove', file: 'File', open: 'Open', download: 'Download',
    syncOk: 'Up to date', syncBusy: 'Syncing…', syncOff: 'Offline', syncErr: "Couldn't sync",
    theme: 'Theme', themeSystem: 'System', themeLight: 'Light', themeDark: 'Dark', accent: 'Color', language: 'Language', linkedTo: 'Linked to {p}', unlink: 'Unlink this computer', unlinkSure: 'Click again to unlink',
    unlinkHint: 'What is in this browser is erased. Nothing changes on the phone.',
    linkTitle: 'Novelo on the computer', linkLead: 'To write calmly. Everything in step with the phone.', link1: 'Open Novelo on the phone', link2: 'Settings › Computer › Link a computer', link3: 'Point the phone at this code',
    linkSafe: "The phone sends the key straight to this computer, encrypted. The server can't read anything you keep.", linkExpired: 'The code expired.', linkNew: 'Show another', linkWaiting: 'Waiting for the phone…', linking: 'Opening…', linkFailed: "Couldn't link. Try again.",
    unlinked: 'This computer was unlinked from the phone.',
    keepLinked: 'Keep this computer linked', keepLinkedHint: "Uncheck it on someone else's computer: nothing is kept on it, and it unlinks when you close the tab.",
    sharedBadge: 'Nothing is kept here · closing the tab unlinks', mic: 'Speak', micStop: 'Stop and write', micCancel: 'Discard the recording', micHearing: 'Transcribing…', micDenied: 'No access to the microphone. Allow it in the lock in the address bar.', micNone: 'No microphone found.', micNothing: 'I heard nothing.', micFailed: "Couldn't transcribe now.", micOffline: 'No internet to transcribe now.', install: 'Install as an app', installHint: 'Opens in its own window, like a program on the computer.', otherTab: 'Novelo is open in another tab', otherTabHint: 'It works in one tab at a time, so nothing is organized twice.', useHere: 'Use here',
    mobileTitle: 'On the phone, Novelo is the app', mobileLead: 'Talk, and it organizes. The browser version is for the computer.', mobileGet: 'Get Novelo for Android', mobileLink: 'To link the computer: Novelo › Settings › Computer.',
    searchHint: 'Search what you kept', photos: 'Photos', files: 'Files', sound: 'Sound', willAsk: 'Novelo will ask how it is going {d}.', topics: 'Topics',
    next: 'next', now: 'now', tomorrow: 'tomorrow', yesterday: 'yesterday', linkOn: 'on',
  },
};

export const LANGS = { pt: 'Português', es: 'Español', en: 'English' };

export function pickLang(saved) {
  if (saved && S[saved]) return saved;
  const nav = (globalThis.navigator?.language ?? 'pt').toLowerCase();
  return nav.startsWith('es') ? 'es' : nav.startsWith('en') ? 'en' : 'pt';
}

export function strings(lang) {
  const s = S[lang] ?? S.pt;
  return (key, vars = {}) => String(s[key] ?? S.pt[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}

export const LOCALE = { pt: 'pt-BR', es: 'es', en: 'en' };
