import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useColorScheme, type TextInputProps } from 'react-native';

export const palette = (dark: boolean) => ({
  bg: dark ? '#0f1115' : '#f4f6f8', card: dark ? '#191c23' : '#ffffff', text: dark ? '#eef0f4' : '#14161a', muted: dark ? '#9aa3b2' : '#5b6370',
  border: dark ? '#2b303b' : '#dde2e8', green: dark ? '#3fb68b' : '#0b6e4f', greenText: dark ? '#08130f' : '#ffffff',
  warnBg: dark ? '#2b2210' : '#fff4dc', warn: dark ? '#f5c26b' : '#7a4f00', red: dark ? '#f97066' : '#b42318', blue: dark ? '#7aa2ff' : '#1d4ed8',
});
export const useColors = () => palette(useColorScheme() === 'dark');

export function Screen({ children, title, onBack, backLabel }: { children: React.ReactNode; title?: string; onBack?: () => void; backLabel?: string }) {
  const c = useColors();
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ padding: 16, paddingBottom: 48, maxWidth: 560, width: '100%', alignSelf: 'center' }}>
      {onBack && <Pressable onPress={onBack} accessibilityRole="button" style={{ paddingVertical: 8 }}><Text style={{ color: c.blue, fontSize: 18 }}>← {backLabel ?? 'Back'}</Text></Pressable>}
      {title && <Text accessibilityRole="header" style={{ fontSize: 26, fontWeight: '700', color: c.text, marginVertical: 12 }}>{title}</Text>}
      {children}
    </ScrollView>
  );
}

export function Big({ label, onPress, kind = 'primary', disabled, busy, testID, icon }: { label: string; onPress: () => void; kind?: 'primary' | 'secondary' | 'danger'; disabled?: boolean; busy?: boolean; testID?: string; icon?: string }) {
  const c = useColors();
  const bg = kind === 'primary' ? c.green : kind === 'danger' ? c.red : c.card;
  const fg = kind === 'secondary' ? c.text : kind === 'primary' ? c.greenText : '#fff';
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} disabled={disabled || busy} onPress={onPress}
      style={({ pressed }) => [s.big, { backgroundColor: bg, borderColor: kind === 'secondary' ? c.border : bg, opacity: disabled ? 0.45 : pressed ? 0.85 : 1 }]}>
      {busy ? <ActivityIndicator color={fg} /> : <Text style={{ color: fg, fontSize: 20, fontWeight: '700' }}>{icon ? `${icon}  ` : ''}{label}</Text>}
    </Pressable>
  );
}

export function Card({ children, onPress, testID }: { children: React.ReactNode; onPress?: () => void; testID?: string }) {
  const c = useColors();
  const style = [s.card, { backgroundColor: c.card, borderColor: c.border }];
  return onPress
    ? <Pressable testID={testID} accessibilityRole="button" onPress={onPress} style={({ pressed }) => [...style, { opacity: pressed ? 0.85 : 1 }]}>{children}</Pressable>
    : <View testID={testID} style={style}>{children}</View>;
}

export function T({ children, size = 17, bold, muted, color, style }: { children: React.ReactNode; size?: number; bold?: boolean; muted?: boolean; color?: string; style?: object }) {
  const c = useColors();
  return <Text style={[{ fontSize: size, color: color ?? (muted ? c.muted : c.text), fontWeight: bold ? '700' : '400', lineHeight: size * 1.35 }, style]}>{children}</Text>;
}

export function Banner({ text, kind = 'warn' }: { text: string; kind?: 'warn' | 'error' | 'ok' }) {
  const c = useColors();
  const map = { warn: [c.warnBg, c.warn], error: ['#fde8e7', c.red], ok: ['#e3f6ee', c.green] } as const;
  const [bg, fg] = map[kind];
  return <View style={{ backgroundColor: bg, padding: 12, borderRadius: 10, marginVertical: 8 }}><Text style={{ color: fg, fontSize: 16, fontWeight: '600' }}>{text}</Text></View>;
}

export function Field(props: TextInputProps & { label: string }) {
  const c = useColors();
  return (
    <View style={{ marginVertical: 8 }}>
      <Text style={{ color: c.text, fontSize: 17, marginBottom: 6, fontWeight: '600' }}>{props.label}</Text>
      <TextInput accessibilityLabel={props.label} placeholderTextColor={c.muted} {...props}
        style={[{ borderWidth: 1, borderColor: c.border, backgroundColor: c.card, color: c.text, borderRadius: 10, padding: 14, fontSize: 22 }, props.style]} />
    </View>
  );
}

export function Chip({ label, on, onPress, testID }: { label: string; on: boolean; onPress: () => void; testID?: string }) {
  const c = useColors();
  return (
    <Pressable testID={testID} accessibilityRole="checkbox" accessibilityState={{ checked: on }} onPress={onPress}
      style={{ paddingVertical: 10, paddingHorizontal: 16, borderRadius: 99, borderWidth: 1, margin: 4, borderColor: on ? c.green : c.border, backgroundColor: on ? c.green : c.card }}>
      <Text style={{ color: on ? c.greenText : c.text, fontSize: 17 }}>{on ? '✓ ' : ''}{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  big: { minHeight: 60, borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, marginVertical: 6, borderWidth: 1 },
  card: { borderRadius: 14, borderWidth: 1, padding: 16, marginVertical: 6 },
});
