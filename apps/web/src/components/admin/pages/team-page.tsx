'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, MoreHorizontal, PauseCircle, PlayCircle, Plus, ShieldCheck, Trash2, UserCog, Users } from 'lucide-react';
import { canManageRole, ROLES, type CreateUserRequest, type Role, type UpdateUserRequest, type UserDTO } from '@scenox/shared';
import { api, errorMessage } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { useMe, usePermission } from '@/lib/hooks/use-me';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SimpleSelect } from '@/components/ui/select';
import { toast } from '@/components/ui/toaster';
import { EMAIL_RE } from '../tag-input';
import { ErrorState } from '../query-state';
import { RelativeTime } from '../relative-time';

const ROLE_INFO: Record<Role, string> = {
  owner: 'Full control, including billing-level settings and other owners.',
  admin: 'Everything except managing owners and other admins.',
  member: 'Manage clients, portals and files. No deletion or audit access.',
  viewer: 'Read-only access to clients, portals and files.',
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function AddMemberDialog({ open, onOpenChange, actorRole }: { open: boolean; onOpenChange: (o: boolean) => void; actorRole: Role }) {
  const qc = useQueryClient();
  const roles = ROLES.filter((r) => canManageRole(actorRole, r));
  const [f, setF] = React.useState({ name: '', email: '', role: (roles.includes('member') ? 'member' : roles[0]) as Role, password: '' });
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    if (open) {
      setF({ name: '', email: '', role: roles.includes('member') ? 'member' : roles[0]!, password: '' });
      setErrors({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const create = useMutation({
    mutationFn: (b: CreateUserRequest) => api.post<UserDTO>('/users', b),
    onSuccess: (u) => {
      toast.success(`${u.name} added`, { description: 'Share the temporary password with them securely.' });
      void qc.invalidateQueries({ queryKey: queryKeys.users });
      onOpenChange(false);
    },
    onError: (e) => toast.error("Couldn't add the team member", { description: errorMessage(e) }),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!f.name.trim()) next.name = 'Enter a name';
    if (!EMAIL_RE.test(f.email.trim())) next.email = 'Enter a valid email address';
    if (f.password.length < 12) next.password = 'Use at least 12 characters';
    setErrors(next);
    if (Object.keys(next).length) return;
    create.mutate({ name: f.name.trim(), email: f.email.trim().toLowerCase(), role: f.role, password: f.password });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !create.isPending && onOpenChange(o)}>
      <DialogContent className="max-w-md">
        <form onSubmit={submit} noValidate className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Add team member</DialogTitle>
            <DialogDescription>They can sign in right away with the temporary password you set.</DialogDescription>
          </DialogHeader>
          <Field label="Name" required error={errors.name}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus autoComplete="off" /></Field>
          <Field label="Email" required error={errors.email}><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="off" /></Field>
          <Field label="Role" hint={ROLE_INFO[f.role]}>
            <SimpleSelect value={f.role} onValueChange={(v) => setF({ ...f, role: v as Role })} options={roles.map((r) => ({ value: r, label: cap(r) }))} />
          </Field>
          <Field label="Temporary password" required error={errors.password} hint="At least 12 characters.">
            <Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>Cancel</Button>
            <Button type="submit" loading={create.isPending}>Add member</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordDialog({ user, onOpenChange }: { user: UserDTO | null; onOpenChange: (o: boolean) => void }) {
  const [pw, setPw] = React.useState('');
  const [error, setError] = React.useState<string>();
  React.useEffect(() => { if (user) { setPw(''); setError(undefined); } }, [user]);
  const reset = useMutation({
    mutationFn: () => api.patch<UserDTO>(`/users/${user!.id}`, { password: pw }),
    onSuccess: () => { toast.success('Password reset', { description: `Share the new password with ${user!.name} securely.` }); onOpenChange(false); },
    onError: (e) => toast.error("Couldn't reset the password", { description: errorMessage(e) }),
  });
  return (
    <Dialog open={!!user} onOpenChange={(o) => !reset.isPending && onOpenChange(o)}>
      <DialogContent className="max-w-md">
        <form onSubmit={(e) => { e.preventDefault(); if (pw.length < 12) return setError('Use at least 12 characters'); reset.mutate(); }} noValidate className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Reset password</DialogTitle>
            <DialogDescription>Set a new temporary password for {user?.name}. Their active sessions are signed out.</DialogDescription>
          </DialogHeader>
          <Field label="New password" required error={error} hint="At least 12 characters."><Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" autoFocus /></Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={reset.isPending}>Cancel</Button>
            <Button type="submit" loading={reset.isPending}>Reset password</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function TeamPage() {
  const { data: me } = useMe();
  const canManage = usePermission('team.manage');
  const qc = useQueryClient();
  const [addOpen, setAddOpen] = React.useState(false);
  const [resetUser, setResetUser] = React.useState<UserDTO | null>(null);
  const [removeUser, setRemoveUser] = React.useState<UserDTO | null>(null);

  const { data, isPending, error, refetch, isFetching } = useQuery({
    queryKey: queryKeys.users,
    queryFn: ({ signal }) => api.get<UserDTO[]>('/users', { signal }),
  });

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateUserRequest; label: string }) => api.patch<UserDTO>(`/users/${id}`, body),
    onSuccess: (_u, v) => { toast.success(v.label); void qc.invalidateQueries({ queryKey: queryKeys.users }); },
    onError: (e) => toast.error("Couldn't update the team member", { description: errorMessage(e) }),
  });

  const myRole = me?.user.role;
  const columns: DataTableColumn<UserDTO>[] = [
    {
      key: 'name',
      header: 'Member',
      className: 'min-w-56',
      cell: (u) => (
        <div className="flex items-center gap-3">
          <Avatar name={u.name} />
          <div className="min-w-0">
            <p className="truncate font-medium">{u.name}{u.id === me?.user.id && <Badge className="ml-2 align-middle">You</Badge>}</p>
            <p className="truncate text-xs text-fg-subtle">{u.email}</p>
          </div>
        </div>
      ),
    },
    { key: 'role', header: 'Role', cell: (u) => <Badge tone={u.role === 'owner' ? 'primary' : 'neutral'}>{u.role === 'owner' && <ShieldCheck aria-hidden />}{cap(u.role)}</Badge> },
    { key: 'status', header: 'Status', cell: (u) => (u.status === 'active' ? <Badge tone="success">Active</Badge> : <Badge tone="neutral"><PauseCircle aria-hidden /> Disabled</Badge>) },
    { key: 'lastLoginAt', header: 'Last sign-in', className: 'hidden md:table-cell', cell: (u) => <RelativeTime date={u.lastLoginAt} fallback="Never" className="whitespace-nowrap tabular-nums text-fg-muted" /> },
    ...(canManage
      ? ([{
          key: 'actions',
          header: <span className="sr-only">Actions</span>,
          align: 'right',
          className: 'w-12',
          cell: (u: UserDTO) => {
            const self = u.id === me?.user.id;
            const manageable = !!myRole && !self && canManageRole(myRole, u.role);
            if (!manageable) return <span className="sr-only">No actions available</span>;
            const roles = ROLES.filter((r) => r !== u.role && canManageRole(myRole!, r));
            return (
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-8" aria-label={`Actions for ${u.name}`}><MoreHorizontal aria-hidden /></Button></DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {roles.length > 0 && (
                    <>
                      <DropdownMenuLabel>Change role</DropdownMenuLabel>
                      {roles.map((r) => (
                        <DropdownMenuItem key={r} onSelect={() => update.mutate({ id: u.id, body: { role: r }, label: `${u.name} is now ${r === 'admin' ? 'an' : 'a'} ${r}` })}><UserCog aria-hidden /> Make {r}</DropdownMenuItem>
                      ))}
                      <DropdownMenuSeparator />
                    </>
                  )}
                  <DropdownMenuItem onSelect={() => update.mutate({ id: u.id, body: { status: u.status === 'active' ? 'disabled' : 'active' }, label: u.status === 'active' ? `${u.name} disabled` : `${u.name} enabled` })}>
                    {u.status === 'active' ? <PauseCircle aria-hidden /> : <PlayCircle aria-hidden />} {u.status === 'active' ? 'Disable' : 'Enable'}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setResetUser(u)}><KeyRound aria-hidden /> Reset password</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem destructive onSelect={() => setRemoveUser(u)}><Trash2 aria-hidden /> Remove</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            );
          },
        }] as DataTableColumn<UserDTO>[])
      : []),
  ];

  const addButton = canManage && <Button onClick={() => setAddOpen(true)}><Plus aria-hidden /> Add member</Button>;

  return (
    <>
      <PageHeader title="Team" description="People who can sign in to this vault, and what they can do." actions={addButton} />
      {error && !data ? (
        <div className="rounded-lg border border-border bg-surface"><ErrorState error={error} onRetry={() => refetch()} retrying={isFetching} title="Couldn't load the team" /></div>
      ) : (
        <DataTable
          caption="Team members"
          columns={columns}
          rows={data ?? []}
          getRowId={(u) => u.id}
          loading={isPending}
          empty={<EmptyState icon={<Users />} title="No team members" description="Invite someone to help manage clients and files." action={addButton || undefined} />}
        />
      )}
      {myRole && <AddMemberDialog open={addOpen} onOpenChange={setAddOpen} actorRole={myRole} />}
      <ResetPasswordDialog user={resetUser} onOpenChange={(o) => !o && setResetUser(null)} />
      <ConfirmDialog
        open={!!removeUser}
        onOpenChange={(o) => !o && setRemoveUser(null)}
        title="Remove team member?"
        description={removeUser ? `${removeUser.name} will immediately lose access. Files and activity they created are kept.` : undefined}
        confirmLabel="Remove member"
        destructive
        onConfirm={async () => {
          if (!removeUser) return;
          try {
            await api.delete(`/users/${removeUser.id}`);
            toast.success(`${removeUser.name} removed`);
            void qc.invalidateQueries({ queryKey: queryKeys.users });
          } catch (e) {
            toast.error("Couldn't remove the team member", { description: errorMessage(e) });
            throw e;
          }
        }}
      />
    </>
  );
}
